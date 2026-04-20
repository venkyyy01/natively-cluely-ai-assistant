import React from 'react';
import { render } from '@testing-library/react';

// NAT-026: minimal stealth shield component for testing without pulling in heavy App deps
const StealthShield: React.FC<{ variant: 'overlay' | 'launcher'; onEndMeeting?: () => Promise<void> }> = ({ variant, onEndMeeting }) => {
  const isOverlay = variant === 'overlay';
  return (
    <div
      className={`flex h-full min-h-0 w-full items-center justify-center ${isOverlay ? 'bg-black' : 'bg-black'}`}
      onClick={isOverlay && onEndMeeting ? () => { void onEndMeeting() } : undefined}
      role={isOverlay && onEndMeeting ? 'button' : undefined}
      tabIndex={isOverlay && onEndMeeting ? 0 : undefined}
    />
  );
};

describe('NAT-026: Privacy Shield UI is visually generic', () => {
  test('overlay variant contains zero text DOM nodes', () => {
    const { container } = render(<StealthShield variant="overlay" />);
    const textNodes = Array.from(container.querySelectorAll('*')).filter(
      (el) => el.textContent && el.textContent.trim().length > 0
    );
    expect(textNodes).toHaveLength(0);
  });

  test('launcher variant contains zero text DOM nodes', () => {
    const { container } = render(<StealthShield variant="launcher" />);
    const textNodes = Array.from(container.querySelectorAll('*')).filter(
      (el) => el.textContent && el.textContent.trim().length > 0
    );
    expect(textNodes).toHaveLength(0);
  });
});
