const image = {
  templates: {
    image: {
      static: {
        portRange: [3000, 4000],
      },
      args: {
        headless: true,
      },
      renderDurationWarning: 5000,
      navigationTimeout: 30000,
      renderTimeout: 30000,
    },
  },
};

export default image;
