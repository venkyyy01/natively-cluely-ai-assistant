import { dialog } from 'electron';
import type { AppState } from '../main';
import type { SafeHandle } from './registerTypes';

type RegisterProfileHandlersDeps = {
  appState: AppState;
  safeHandle: SafeHandle;
};

export function registerProfileHandlers({ appState, safeHandle }: RegisterProfileHandlersDeps): void {
  safeHandle('profile:upload-resume', async (_event, filePath: string) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Knowledge engine not initialized. Please ensure API keys are configured.' };
      const { DocType } = require('../../premium/electron/knowledge/types');
      return orchestrator.ingestDocument(filePath, DocType.RESUME);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('profile:get-status', async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { hasProfile: false, profileMode: false };
      const status = orchestrator.getStatus();
      return {
        hasProfile: status.hasResume,
        profileMode: status.activeMode,
        name: status.resumeSummary?.name,
        role: status.resumeSummary?.role,
        totalExperienceYears: status.resumeSummary?.totalExperienceYears,
      };
    } catch {
      return { hasProfile: false, profileMode: false };
    }
  });

  safeHandle('profile:set-mode', async (_event, enabled: boolean) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Knowledge engine not initialized' };
      orchestrator.setKnowledgeMode(enabled);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('profile:delete', async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Knowledge engine not initialized' };
      const { DocType } = require('../../premium/electron/knowledge/types');
      orchestrator.deleteDocumentsByType(DocType.RESUME);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('profile:get-profile', async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return null;
      return orchestrator.getProfileData();
    } catch {
      return null;
    }
  });

  safeHandle('profile:select-file', async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Resume Files', extensions: ['pdf', 'docx', 'txt'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
      return { success: true, filePath: result.filePaths[0] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('profile:upload-jd', async (_event, filePath: string) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Knowledge engine not initialized. Please ensure API keys are configured.' };
      const { DocType } = require('../../premium/electron/knowledge/types');
      return orchestrator.ingestDocument(filePath, DocType.JD);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('profile:delete-jd', async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Knowledge engine not initialized' };
      const { DocType } = require('../../premium/electron/knowledge/types');
      orchestrator.deleteDocumentsByType(DocType.JD);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('profile:research-company', async (_event, companyName: string) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Knowledge engine not initialized' };
      const engine = orchestrator.getCompanyResearchEngine();
      const { CredentialsManager } = require('../services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const googleSearchKey = cm.getGoogleSearchApiKey();
      const googleSearchCseId = cm.getGoogleSearchCseId();
      if (googleSearchKey && googleSearchCseId) {
        const { GoogleCustomSearchProvider } = require('../../premium/electron/knowledge/GoogleCustomSearchProvider');
        engine.setSearchProvider(new GoogleCustomSearchProvider(googleSearchKey, googleSearchCseId));
      }
      const profileData = orchestrator.getProfileData();
      const activeJD = profileData?.activeJD;
      const jdCtx = activeJD ? {
        title: activeJD.title,
        location: activeJD.location,
        level: activeJD.level,
        technologies: activeJD.technologies,
        requirements: activeJD.requirements,
        keywords: activeJD.keywords,
        compensation_hint: activeJD.compensation_hint,
        min_years_experience: activeJD.min_years_experience,
      } : {};
      const dossier = await engine.researchCompany(companyName, jdCtx, true);
      return { success: true, dossier };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('profile:generate-negotiation', async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Knowledge engine not initialized' };
      const profileData = orchestrator.getProfileData();
      if (!profileData) return { success: false, error: 'No resume uploaded' };
      const status = orchestrator.getStatus();
      if (!status.hasResume) return { success: false, error: 'No resume loaded' };
      let dossier = null;
      if (profileData.activeJD?.company) {
        dossier = orchestrator.getCompanyResearchEngine().getCachedDossier(profileData.activeJD.company);
      }
      return { success: true, dossier, profileData };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('set-google-search-api-key', async (_event, apiKey: string) => {
    try {
      const { CredentialsManager } = require('../services/CredentialsManager');
      CredentialsManager.getInstance().setGoogleSearchApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle('set-google-search-cse-id', async (_event, cseId: string) => {
    try {
      const { CredentialsManager } = require('../services/CredentialsManager');
      CredentialsManager.getInstance().setGoogleSearchCseId(cseId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
