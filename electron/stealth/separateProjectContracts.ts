export type DeepStealthProject =
  | 'macos-virtual-display-helper'
  | 'windows-idd-driver'
  | 'windows-protected-render-host'
  | 'integration-harness';

export interface DeepStealthScaffoldStatus {
  project: DeepStealthProject;
  scaffolded: true;
  implementationReady: false;
  nextStep: string;
}

export const DEEP_STEALTH_SCAFFOLDS: DeepStealthScaffoldStatus[] = [
  {
    project: 'macos-virtual-display-helper',
    scaffolded: true,
    implementationReady: false,
    nextStep: 'Implement CGVirtualDisplay session creation and compositor handoff.',
  },
  {
    project: 'windows-idd-driver',
    scaffolded: true,
    implementationReady: false,
    nextStep: 'Create the UMDF2/IddCx driver solution and installer pipeline.',
  },
  {
    project: 'windows-protected-render-host',
    scaffolded: true,
    implementationReady: false,
    nextStep: 'Build protected swap-chain capability detection and rendering path.',
  },
  {
    project: 'integration-harness',
    scaffolded: true,
    implementationReady: false,
    nextStep: 'Automate the manual capture-validation matrix across supported platforms.',
  },
];
