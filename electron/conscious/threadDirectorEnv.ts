/**
 * NAT-055: gate unified thread orchestration behind env until rollout is stable.
 */
export function isNativelyThreadDirectorEnabled(): boolean {
	return process.env.NATIVELY_THREAD_DIRECTOR === "1";
}
