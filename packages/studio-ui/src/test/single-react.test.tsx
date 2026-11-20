import { render, screen } from '@testing-library/react';
import { Activity } from 'lucide-react';
import { motion } from 'motion/react';
import { describe, expect, it } from 'vitest';

// The root node_modules holds React 18 for another workspace; these packages are hoisted next to it and must still
// render with the app's React 19 (vitest.config.ts).
describe('one React copy in tests', () => {
  it('renders a lucide icon', () => {
    render(<Activity data-testid="icon" />);
    expect(screen.getByTestId('icon').tagName).toBe('svg');
  });

  it('renders a motion element', () => {
    render(<motion.div data-testid="motion">moving</motion.div>);
    expect(screen.getByTestId('motion')).toHaveTextContent('moving');
  });
});
