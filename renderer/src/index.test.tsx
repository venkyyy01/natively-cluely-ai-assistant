import React from 'react';

test('index bootstraps the react root and starts web vitals reporting', () => {
  document.body.innerHTML = '<div id="root"></div>';

  const mockRender = jest.fn();
  const mockCreateRoot = jest.fn(() => ({ render: mockRender }));
  const mockReportWebVitals = jest.fn();

  jest.resetModules();
  jest.doMock('react-dom/client', () => ({
    __esModule: true,
    default: {
      createRoot: mockCreateRoot,
    },
  }));
  jest.doMock('./reportWebVitals', () => ({
    __esModule: true,
    default: mockReportWebVitals,
  }));

  require('./index');

  expect(mockCreateRoot).toHaveBeenCalledWith(document.getElementById('root'));
  expect(mockRender).toHaveBeenCalledTimes(1);
  expect(mockRender).toHaveBeenCalledWith(
    <React.StrictMode>
      {expect.anything()}
    </React.StrictMode>,
  );
  expect(mockReportWebVitals).toHaveBeenCalledTimes(1);
});
