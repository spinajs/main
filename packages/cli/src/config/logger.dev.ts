const log = {
    logger: {
      targets: [
        {
          name: 'Console',
          type: 'ConsoleTarget',
        },
      ],
      rules: [
        { name: '*', level: 'trace', target: 'Console' },
      ],
    },
  };
  
  export default log;
  