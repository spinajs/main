// Fills a variable the way a dotenv helper does: only when it is not set yet.
if (process.env.SECURE_FLAG_FOR_TEST === undefined) process.env.SECURE_FLAG_FOR_TEST = process.env.NODE_ENV === 'production' ? 'on' : 'off';

export const secure = process.env.SECURE_FLAG_FOR_TEST === 'on';
