import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders application shell', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /natively/i })).toBeInTheDocument();
});
