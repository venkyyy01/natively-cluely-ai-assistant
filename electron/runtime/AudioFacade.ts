export interface AudioFacadeDeps {
	getNativeAudioStatus: () => unknown;
}

export class AudioFacade {
	constructor(private readonly deps: AudioFacadeDeps) {}

	getNativeAudioStatus<T = unknown>(): T {
		return this.deps.getNativeAudioStatus() as T;
	}
}
