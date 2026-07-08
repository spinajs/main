import { expect } from 'chai';
import * as textHelpers from '../../src/helpers/text.js';

// Mimics the options object Handlebars appends as the final argument to every helper call.
const OPT: any = { hash: {}, data: { root: {} }, loc: {}, name: 'helper' };

describe('Text Helpers', () => {
  describe('Case Conversion', () => {
    it('should convert to uppercase', () => {
      expect(textHelpers.uppercase('hello')).to.equal('HELLO');
    });

    it('should convert to lowercase', () => {
      expect(textHelpers.lowercase('HELLO')).to.equal('hello');
    });

    it('should capitalize first letter', () => {
      expect(textHelpers.capitalize('hello world')).to.equal('Hello world');
    });

    it('should capitalize each word', () => {
      expect(textHelpers.capitalizeWords('hello world')).to.equal('Hello World');
    });
  });

  describe('Case Styles', () => {
    it('should convert to camelCase', () => {
      expect(textHelpers.camelCase('hello world')).to.equal('helloWorld');
      expect(textHelpers.camelCase('Hello-World')).to.equal('helloWorld');
    });

    it('should convert to snake_case', () => {
      expect(textHelpers.snakeCase('helloWorld')).to.equal('hello_world');
      expect(textHelpers.snakeCase('Hello World')).to.equal('hello_world');
    });

    it('should convert to kebab-case', () => {
      expect(textHelpers.kebabCase('helloWorld')).to.equal('hello-world');
      expect(textHelpers.kebabCase('Hello World')).to.equal('hello-world');
    });

    it('should slugify string', () => {
      expect(textHelpers.slugify('Hello World!')).to.equal('hello-world');
      expect(textHelpers.slugify('Hello  World  123')).to.equal('hello-world-123');
    });
  });

  describe('Truncation', () => {
    it('should truncate string', () => {
      expect(textHelpers.truncate('Hello World', 5)).to.equal('Hello...');
      expect(textHelpers.truncate('Hi', 5)).to.equal('Hi');
    });

    it('should truncate by words', () => {
      expect(textHelpers.truncateWords('The quick brown fox', 2)).to.equal('The quick...');
      expect(textHelpers.truncateWords('Hello', 2)).to.equal('Hello');
    });
  });

  describe('String Manipulation', () => {
    it('should reverse string', () => {
      expect(textHelpers.reverse('hello')).to.equal('olleh');
    });

    it('should repeat string', () => {
      expect(textHelpers.repeat('hi', 3)).to.equal('hihihi');
    });

    it('should replace string', () => {
      expect(textHelpers.replace('hello world', 'world', 'universe')).to.equal('hello universe');
    });

    it('should trim whitespace', () => {
      expect(textHelpers.trim('  hello  ')).to.equal('hello');
      expect(textHelpers.trimLeft('  hello')).to.equal('hello');
      expect(textHelpers.trimRight('hello  ')).to.equal('hello');
    });

    it('should get substring', () => {
      expect(textHelpers.substring('hello world', 0, 5)).to.equal('hello');
    });

    it('should get length', () => {
      expect(textHelpers.length('hello')).to.equal(5);
      expect(textHelpers.length([1, 2, 3])).to.equal(3);
    });
  });

  describe('Padding', () => {
    it('should pad left', () => {
      expect(textHelpers.padLeft('5', 3, '0')).to.equal('005');
    });

    it('should pad right', () => {
      expect(textHelpers.padRight('5', 3, '0')).to.equal('500');
    });

    it('should align text right', () => {
      expect(textHelpers.__textRight('hello', 10)).to.equal('     hello');
    });

    it('should center text', () => {
      expect(textHelpers.__textCenter('hello', 11)).to.equal('   hello   ');
    });
  });

  describe('HTML', () => {
    it('should strip HTML tags', () => {
      expect(textHelpers.stripHtml('<p>Hello</p>')).to.equal('Hello');
      expect(textHelpers.stripHtml('<div class="test">World</div>')).to.equal('World');
    });

    it('should escape HTML', () => {
      expect(textHelpers.escapeHtml('<div>')).to.equal('&lt;div&gt;');
      expect(textHelpers.escapeHtml('a & b')).to.equal('a &amp; b');
    });
  });

  describe('Array Operations', () => {
    it('should split string', () => {
      expect(textHelpers.split('a,b,c', ',')).to.deep.equal(['a', 'b', 'c']);
    });

    it('should join array', () => {
      expect(textHelpers.join(['a', 'b', 'c'], ', ')).to.equal('a, b, c');
    });
  });

  // Handlebars appends its options object as the last arg; helpers with a trailing
  // optional-default param must fall back to the default instead of using that object.
  describe('Handlebars options-arg guards', () => {
    it('truncate uses default suffix when suffix arg is the options object', () => {
      expect(textHelpers.truncate('Hello World', 5, OPT)).to.equal('Hello...');
    });

    it('truncateWords uses default suffix when suffix arg is the options object', () => {
      expect(textHelpers.truncateWords('The quick brown fox', 2, OPT)).to.equal('The quick...');
    });

    it('join uses default separator when separator arg is the options object', () => {
      expect(textHelpers.join(['a', 'b', 'c'], OPT)).to.equal('a, b, c');
    });

    it('padLeft uses default space char when char arg is the options object', () => {
      expect(textHelpers.padLeft('5', 3, OPT)).to.equal('  5');
    });

    it('padRight uses default space char when char arg is the options object', () => {
      expect(textHelpers.padRight('5', 3, OPT)).to.equal('5  ');
    });

    it('substring ignores the options object as end index', () => {
      expect(textHelpers.substring('hello world', 6, OPT)).to.equal('world');
    });
  });
});
