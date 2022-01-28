module.exports = {
    logger: {
        variables: [],
        targets: [
            {
                name: "File",
                type: "FileTarget",
                options: {
                    path: "./test/logs/log_{date:dd_MM_yyyy}.txt",
                    archivePath: "./test/logs/archive",
                    maxSize: 1024 * 1024,
                    compress: true,
                    rotate: "*/2 * * * *",
                    maxArchiveFiles: 5,
                    bufferSize: 8 * 1024
                }

            },
            {
                name: "Console", type: "ConsoleTarget", options: {
                    theme: {
                        security: ['red', "bgBrightWhite"],
                        fatal: 'red',
                        error: 'brightRed',
                        warn: 'yellow',
                        success: 'green',
                        info: 'white',
                        debug: 'gray',
                        trace: 'gray',
                    }
                }
            }
        ],
        rules: [
            { name: "*", level: "trace", target: "Console" },
            { name: "FileLogger", level: "trace", target: "File" }
        ],

    }
}