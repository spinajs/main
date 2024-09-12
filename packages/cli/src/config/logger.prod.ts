const log = {
    logger: {
      targets: [
        {
          name: 'Console',
          type: 'ConsoleTarget',
        },
      ],
      rules: [
        { name: '*', level: 'info', target: 'Console' },
      ],
    },
  };
  
  export default log;
  