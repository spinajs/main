import 'mocha';
import { expect } from 'chai';
import { crossSiteRefusal, isAllowedOrigin } from '../src/origin.js';

describe('origin guard', () => {
  describe('isAllowedOrigin', () => {
    it('admits a request without an Origin ( not a browser )', () => {
      expect(isAllowedOrigin({ host: 'app.example' }, [])).to.be.true;
    });

    it('compares scheme, host and port, with the host lowercased and default ports dropped', () => {
      expect(isAllowedOrigin({ origin: 'http://app.example', host: 'APP.example:80' }, [])).to.be.true;
      expect(isAllowedOrigin({ origin: 'https://app.example', host: 'app.example:443' }, [], true)).to.be.true;
      expect(isAllowedOrigin({ origin: 'http://app.example', host: 'app.example' }, [], true)).to.be.false;
      expect(isAllowedOrigin({ origin: 'http://app.example:8080', host: 'app.example' }, [])).to.be.false;
      expect(isAllowedOrigin({ origin: 'http://app.example.evil', host: 'app.example' }, [])).to.be.false;
    });

    it('admits an https page on the same host when the server is plain http ( TLS-terminating proxy ), never an http page on a TLS server', () => {
      expect(isAllowedOrigin({ origin: 'https://app.example', host: 'app.example' }, [], false)).to.be.true;
      expect(isAllowedOrigin({ origin: 'http://app.example', host: 'app.example' }, [], true)).to.be.false;
      expect(isAllowedOrigin({ origin: 'https://evil.example', host: 'app.example' }, [], false)).to.be.false;
    });

    it('refuses a Host header that is not a bare host and port', () => {
      expect(isAllowedOrigin({ origin: 'http://app.example', host: 'app.example/path' }, [])).to.be.false;
      expect(isAllowedOrigin({ origin: 'http://app.example', host: 'user@app.example' }, [])).to.be.false;
    });

    it('admits exactly listed origins, never null or a wildcard', () => {
      expect(isAllowedOrigin({ origin: 'https://other.example', host: 'app.example' }, ['https://other.example'])).to.be.true;
      expect(isAllowedOrigin({ origin: 'null', host: 'app.example' }, ['null'])).to.be.false;
      expect(isAllowedOrigin({ origin: '*', host: 'app.example' }, ['*'])).to.be.false;
    });
  });

  describe('crossSiteRefusal', () => {
    it('refuses JSONP polling, with or without an Origin', () => {
      expect(crossSiteRefusal({}, '/socket.io/?EIO=4&transport=polling&j=0')).to.be.a('string');
      expect(crossSiteRefusal({ origin: 'http://app.example' }, '/socket.io/?EIO=4&transport=polling&j=')).to.be.a('string');
    });

    it('refuses cross-site and same-site browser requests that carry no Origin', () => {
      expect(crossSiteRefusal({ 'sec-fetch-site': 'cross-site' }, '/socket.io/?EIO=4&transport=polling')).to.be.a('string');
      expect(crossSiteRefusal({ 'sec-fetch-site': 'same-site' }, '/socket.io/?EIO=4&transport=polling')).to.be.a('string');
    });

    it('leaves requests with an Origin to the origin check', () => {
      expect(crossSiteRefusal({ origin: 'https://app.example', 'sec-fetch-site': 'cross-site' }, '/socket.io/?EIO=4&transport=websocket')).to.be.null;
    });

    it('admits same-origin, user-initiated and non-browser requests', () => {
      expect(crossSiteRefusal({ 'sec-fetch-site': 'same-origin' }, '/socket.io/?EIO=4&transport=polling')).to.be.null;
      expect(crossSiteRefusal({ 'sec-fetch-site': 'none' }, '/socket.io/?EIO=4&transport=polling')).to.be.null;
      expect(crossSiteRefusal({}, '/socket.io/?EIO=4&transport=polling')).to.be.null;
      expect(crossSiteRefusal({}, undefined)).to.be.null;
    });
  });
});
