import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import express from 'express';

// The built config: ts-node's type check rejects the default helmet import that the build accepts.
import shipped from '../lib/mjs/config/http.js';

chai.use(chaiHttp);

describe('shipped http config', () => {
  it('sends Referrer-Policy strict-origin-when-cross-origin, so same-origin form posts keep their Origin (A22)', async () => {
    const app = express();
    for (const m of shipped.http.middlewares) app.use(m as express.RequestHandler);
    app.all('/probe', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await chai.request(app).get('/probe');
    expect(res.status).to.eq(200);
    expect(res.header['referrer-policy']).to.eq('strict-origin-when-cross-origin');
    // The other helmet defaults stay.
    expect(res.header['x-content-type-options']).to.eq('nosniff');
    expect(res.header['content-security-policy']).to.be.a('string');
    expect(res.header['strict-transport-security']).to.be.a('string');
  });
});
