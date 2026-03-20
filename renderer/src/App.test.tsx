import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the default app shell content', () => {
  render(<App />);

  expect(screen.getByAltText('logo')).toBeInTheDocument();
  expect(screen.getByText(/edit/i)).toBeInTheDocument();
  expect(screen.getByText('src/App.tsx')).toBeInTheDocument();

  const link = screen.getByRole('link', { name: /learn react/i });
  expect(link).toHaveAttribute('href', 'https://reactjs.org');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
