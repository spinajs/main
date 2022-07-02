/**
 * Localisation configuration, structure like in
 * https://github.com/mashpie/i18n-node
 */
const config = {
  intl: {
    defaultLocale: 'en',

    // supported locales
    locales: ['en'],

    // query parameter to switch locale (ie. /home?lang=ch) - defaults to NULL
    queryParameter: 'lang',
  },
};

export default config;
