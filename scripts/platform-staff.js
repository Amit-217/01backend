require('dotenv').config();
const { userInfo } = require('node:os');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const connectDB = require('../src/config/db.config');
const { hashPassword } = require('../src/common/utils/helpers');
const { PlatformStaff, PlatformSession, PlatformAudit } = require('../src/modules/platform/platform.model');
const { staffIdentity } = require('../src/modules/platform/platform.validation');
const { seal, base32, requiresTotp } = require('../src/modules/platform/platform.totp');

async function main() {
  const [command, address, role, ...nameParts] = process.argv.slice(2);
  if (!['enroll', 'rotate', 'disable'].includes(command)) {
    throw new Error('Use platform-staff.js enroll|rotate <email> <support|operator> <name> or disable <email>.');
  }
  const email = staffIdentity.shape.email.parse(address);
  const provisions = command !== 'disable';
  if (provisions && !process.stdout.isTTY) throw new Error('Use a private interactive terminal for enrollment.');
  const identity = provisions ? staffIdentity.parse({
    email, role, name: nameParts.join(' '), password: process.env.PLATFORM_STAFF_PASSWORD,
  }) : null;
  delete process.env.PLATFORM_STAFF_PASSWORD;
  const seed = identity && requiresTotp() ? randomBytes(20) : null;
  const credentials = identity ? {
    email, role: identity.role, name: identity.name, passwordHash: await hashPassword(identity.password),
    active: true, ...(seed ? { totpSecret: seal(seed), lastTotpStep: -1 } : {}),
  } : null;

  await connectDB();
  await Promise.all([PlatformStaff.init(), PlatformSession.init(), PlatformAudit.init()]);
  await mongoose.connection.transaction(async (session) => {
    let staff;
    if (command === 'enroll') {
      [staff] = await PlatformStaff.create([credentials], { session });
    } else {
      staff = await PlatformStaff.findOneAndUpdate({ email }, {
        $set: credentials || { active: false },
      }, { session });
      if (!staff) throw new Error('Staff account not found.');
      await PlatformSession.deleteMany({ staffId: staff._id }, { session });
    }
    await PlatformAudit.create([{
      staffName: 'Host operator ' + userInfo().username, action: 'staff.' + command,
      target: String(staff._id), outcome: 'succeeded', status: 200,
    }], { session });
  });
  if (seed) {
    console.log('Enter this one-time setup key in a TOTP authenticator (SHA-1, 6 digits, 30 seconds):');
    console.log(base32(seed));
  } else if (provisions) {
    console.log('Platform staff credentials saved for password-only sign-in.');
  } else {
    console.log('Platform account disabled and sessions revoked.');
  }
}

main().catch((error) => {
  // Validation and database exceptions can include input values. Keep credential errors out of terminal logs.
  console.error(error.name === 'ZodError' ? 'Invalid staff identity or password settings.'
    : error.code === 11000 ? 'A platform account with this email already exists.'
      : error.name === 'Error' && !error.code ? error.message : 'Staff operation failed.');
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
