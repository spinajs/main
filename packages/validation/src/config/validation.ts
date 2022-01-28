const config = {
    validation: {
        // enable all errors on  validation, not only first one that occurred
        allErrors: true,

        // remove properties that are not defined in schema
        removeAdditional: true,

        // set default values if possible
        useDefaults: true,

        // The option coerceTypes allows you to have your data types coerced to the types specified in your schema type keywords
        coerceTypes: true
    }
}

export default config;