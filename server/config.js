// Configuration for processing modes
export const config = {
  // Processing mode: 'sequential', 'legacy', or 'auto'
  // 'auto' will try sequential first, fallback to legacy
  processingMode: process.env.PROCESSING_MODE || 'auto',
  
  // Enable/disable specific features
  features: {
    sequentialProcessing: false, // Temporarily disabled due to Gemini API overload
    legacyFallback: process.env.ENABLE_LEGACY_FALLBACK !== 'false',
    verboseLogging: process.env.VERBOSE_LOGGING === 'true',
  },
  
  // Rate limiting for sequential processing
  rateLimit: {
    delayBetweenSteps: parseInt(process.env.STEP_DELAY_MS) || 500,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  },
  
  // Prompt configuration
  prompts: {
    useModularPrompts: process.env.USE_MODULAR_PROMPTS !== 'false',
    maxPromptLength: parseInt(process.env.MAX_PROMPT_LENGTH) || 2000,
  }
};

export const getProcessingMode = () => {
  return config.processingMode;
};

export const shouldUseSequential = () => {
  return config.features.sequentialProcessing && 
         (config.processingMode === 'sequential' || config.processingMode === 'auto');
};

export const shouldUseLegacyFallback = () => {
  return config.features.legacyFallback;
};

export const logInfo = (message, ...args) => {
  if (config.features.verboseLogging) {
    console.log(`[CONFIG] ${message}`, ...args);
  }
};