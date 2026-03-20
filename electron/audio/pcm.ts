export function resampleToMonoPcm16(chunk: Buffer, inputSampleRate: number, inputChannels: number, targetSampleRate: number): Buffer {
    const sampleCount = Math.floor(chunk.length / 2);
    if (sampleCount <= 0) {
        return Buffer.alloc(0);
    }

    const input = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        input[i] = chunk.readInt16LE(i * 2);
    }

    let mono: Int16Array;
    if (inputChannels > 1) {
        const monoLength = Math.floor(input.length / inputChannels);
        mono = new Int16Array(monoLength);
        for (let i = 0; i < monoLength; i++) {
            let sum = 0;
            for (let c = 0; c < inputChannels; c++) {
                sum += input[i * inputChannels + c];
            }
            mono[i] = Math.round(sum / inputChannels);
        }
    } else {
        mono = input;
    }

    if (inputSampleRate === targetSampleRate) {
        return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength);
    }

    const factor = inputSampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.floor(mono.length / factor));
    const output = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        output[i] = mono[Math.min(mono.length - 1, Math.floor(i * factor))];
    }

    return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}
