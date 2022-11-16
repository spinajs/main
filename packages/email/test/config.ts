const servers = [
  {
    name: 'test',
    service: 'EmailSenderSmtp',
    host: 'smtp.mailtrap.io',
    port: 2525,
    user: process.env.SPINE_TEST_EMAIL_USER || '9dd1310b3e28cf',
    pass: process.env.SPINE_TEST_EMAIL_PASSWORD || '2535b401d2ae2b',
  },
  {
    name: 'test2',
    service: 'EmailSenderSmtp',
    host: 'smtp.mailtrap.io',
    port: 2525,
    user: process.env.SPINE_TEST_EMAIL_USER || '9dd1310b3e28cf',
    pass: process.env.SPINE_TEST_EMAIL_PASSWORD || '2535b401d2ae2b',
  },
];

export default servers;
