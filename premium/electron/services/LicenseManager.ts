/**
 * Local unlocked LicenseManager.
 *
 * This project variant runs premium features without external license
 * verification. The API shape stays compatible with the original manager so
 * IPC handlers and premium feature code keep working.
 */

export class LicenseManager {
    private static instance: LicenseManager;
    private premiumEnabled = true;

    private constructor() { }

    public static getInstance(): LicenseManager {
        if (!LicenseManager.instance) {
            LicenseManager.instance = new LicenseManager();
        }
        return LicenseManager.instance;
    }

    public activateLicense(_key: string): { success: boolean; error?: string } {
        this.premiumEnabled = true;
        return { success: true };
    }

    public isPremium(): boolean {
        return this.premiumEnabled;
    }

    public deactivate(): void {
        this.premiumEnabled = true;
    }

    public getHardwareId(): string {
        return 'premium-unlocked';
    }

    public clearCache(): void {
        this.premiumEnabled = true;
    }
}
