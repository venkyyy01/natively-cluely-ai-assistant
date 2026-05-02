// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

jest.mock('react-dom/test-utils', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const actual = jest.requireActual('react-dom/test-utils');

  return {
    ...actual,
    act: React.act,
  };
});
