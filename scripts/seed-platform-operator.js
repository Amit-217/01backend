require('dotenv').config({ quiet: true });
const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const { AppError } = require('../src/common/utils/errors');
const { hashPassword } = require('../src/common/utils/helpers');
const { PlatformAudit, PlatformStaff } = require('../src/modules/platform/platform.model');
const { requiresTotp } = require('../src/modules/platform/platform.totp');
const { staffIdentity } = require('../src/modules/platform/platform.validation');

// Concurrent seed runs compete for the same record even if they have different credentials.
const seedId = new mongoose.Types.ObjectId(createHash('sha256').update('viplora.platform.first-operator').digest('hex').slice(0, 24));
const operator = { role: 'operator' };

async function seed() {
  if (!process.env.MONGO_URI) throw new AppError(400, 'Set MONGO_URI before running the seed.');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  if (await PlatformStaff.exists(operator)) return false;
  if (requiresTotp()) throw new AppError(400, 'Use platform staff enrollment while authenticator sign-in is required.');

  const { success, data } = staffIdentity.safeParse({
    name: 'Platform Administrator',
    email: process.env.SUPER_ADMIN_EMAIL,
    password: process.env.SUPER_ADMIN_PASSWORD,
    role: operator.role,
  });
  if (!success) throw new AppError(400, 'Set a valid SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD before running the seed.');
  const { password, ...identity } = data;
  const passwordHash = await hashPassword(password);
  await Promise.all([PlatformStaff.init(), PlatformAudit.init()]);

  try {
    return await mongoose.connection.transaction(async (session) => {
      if (await PlatformStaff.exists(operator).session(session)) return false;
      await PlatformStaff.create([{ _id: seedId, ...identity, passwordHash }], { session });
      await PlatformAudit.create([{
        staffName: 'Platform bootstrap', action: 'staff.enroll', target: String(seedId),
        outcome: 'succeeded', status: 200,
      }], { session });
      return true;
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    if (await PlatformStaff.exists(operator)) return false;
    throw new AppError(409, 'The configured email already belongs to a platform staff account.');
  }
}

seed().then((created) => {
  console.log(created ? 'Platform operator created.' : 'A platform operator already exists. Seed skipped.');
}).catch((error) => {
  console.error(error instanceof AppError ? error.message : 'Platform operator seed failed. Check the database connection and access.');
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
