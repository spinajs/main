import { expect } from 'chai';
import { filePathOfUrl } from '../src/index.js';

describe('filePathOfUrl', () => {
  describe('with POSIX rules', () => {
    it('keeps the root of an absolute path', () => {
      expect(filePathOfUrl('file:///home/app/lib/x.js', false)).to.equal('/home/app/lib/x.js');
    });

    it('does not read a top-level directory with a colon as a drive', () => {
      expect(filePathOfUrl('file:///a:b/x.js', false)).to.equal('/a:b/x.js');
    });

    it('decodes an escaped character', () => {
      expect(filePathOfUrl('file:///home/my%20app/x.js', false)).to.equal('/home/my app/x.js');
    });

    it('refuses a url with a host', () => {
      expect(() => filePathOfUrl('file://server/share/x.js', false)).to.throw();
    });
  });

  describe('with Windows rules', () => {
    it('keeps the drive, in forward slashes', () => {
      expect(filePathOfUrl('file:///C:/app/lib/x.js', true)).to.equal('C:/app/lib/x.js');
    });

    it('keeps the server of a UNC path', () => {
      expect(filePathOfUrl('file://server/share/x.js', true)).to.equal('//server/share/x.js');
    });

    it('decodes an escaped character', () => {
      expect(filePathOfUrl('file:///C:/my%20app/x.js', true)).to.equal('C:/my app/x.js');
    });
  });
});
