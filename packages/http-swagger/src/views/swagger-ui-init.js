window.onload = function () {
  var el = document.getElementById('swagger-ui');
  SwaggerUIBundle({
    url: el.getAttribute('data-spec-url'),
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: 'StandaloneLayout',
  });
};
