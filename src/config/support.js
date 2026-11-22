/** Support contact shown to companies whose access is limited (SUPPORT_NAME, SUPPORT_PHONE, SUPPORT_EMAIL). */
const supportContact = () => ({
  name: (process.env.SUPPORT_NAME || '').trim() || 'Viplora support',
  phone: (process.env.SUPPORT_PHONE || '').trim() || null,
  email: (process.env.SUPPORT_EMAIL || '').trim() || null,
});

/** One sentence such as "Contact Viplora support at +91 98765 43210 or billing@example.com." */
const supportLine = () => {
  const { name, phone, email } = supportContact();
  const ways = [phone, email].filter(Boolean);
  return 'Contact ' + name + (ways.length ? ' at ' + ways.join(' or ') : '') + '.';
};

module.exports = { supportContact, supportLine };
