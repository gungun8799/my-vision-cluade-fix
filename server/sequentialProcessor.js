import PromptManager from './promptManager.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ===== UTILITY FUNCTION TO STRIP THINK TAGS =====
function stripThinkTags(response) {
  if (!response || typeof response !== 'string') {
    return response;
  }
  
  // Remove everything between <think> and </think> tags (including the tags themselves)
  // This handles both single-line and multi-line thinking sections
  let cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // Also handle unclosed think tags - remove from <think> to end of response
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '');
  
  return cleaned.trim();
}

// Verify API key is loaded
if (!process.env.GEMINI_API_KEY) {
  console.error('[SequentialProcessor] GEMINI_API_KEY not found in environment variables');
  throw new Error('GEMINI_API_KEY not configured');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

class SequentialProcessor {
  constructor() {
    this.promptManager = new PromptManager();
  }

  // Helper method for Gemini API calls with retry logic
  async callGeminiWithRetry(prompt, maxRetries = 3, skipOnOverload = false) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const geminiRes = await model.generateContent(prompt);
        const responseText = await geminiRes.response.text();
        return responseText;
      } catch (fetchError) {
        const isServiceOverloaded = fetchError.message && (
          fetchError.message.includes('503 Service Unavailable') || 
          fetchError.message.includes('overloaded')
        );
        
        if (isServiceOverloaded) {
          console.warn(`[⚠️ Gemini API overloaded - attempt ${attempt}/${maxRetries}]`);
          
          // If skipOnOverload is true and we hit overload on first attempt, fail fast
          if (skipOnOverload && attempt === 1) {
            console.warn('[⚡ Fast-failing due to API overload to preserve resources]');
            throw new Error('GEMINI_OVERLOADED');
          }
        } else {
          console.warn(`[⚠️ Sequential Gemini API attempt ${attempt}/${maxRetries} failed]`, fetchError.message);
        }
        
        if (attempt === maxRetries) {
          if (isServiceOverloaded) {
            console.error('[❌ Gemini API consistently overloaded - please try again later]');
            throw new Error('GEMINI_OVERLOADED');
          } else {
            console.error('[❌ All Sequential Gemini API attempts failed]');
            throw new Error(`Sequential Gemini API failed after ${maxRetries} attempts: ${fetchError.message}`);
          }
        }
        
        // Shorter delays when skipOnOverload is true
        const baseDelay = skipOnOverload ? 1000 : (isServiceOverloaded ? 3000 : 1000);
        const waitTime = baseDelay * Math.pow(2, attempt - 1);
        console.log(`[⏳ Sequential waiting ${waitTime}ms before retry...]`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  // Process PDF/Web content in sequential steps
  async processSequential(content, contractType, sourceType = 'pdf', contractNumber = null) {
    const steps = [
      'basic_info',
      'tenant_info', 
      'lease_terms',
      'service_charges',
      'utilities',
      'signatures',
      'citizen_id'
    ];

    let combinedResult = {};
    let isGeminiOverloaded = false;
    
    // Extract contract number from content if not provided
    if (!contractNumber && content) {
      const contractMatch = content.match(/\d{4}_L[OR]\d{4}_\d{5}/);
      contractNumber = contractMatch ? contractMatch[0] : null;
    }
    
    const config = this.promptManager.getContractConfig(contractType, contractNumber);
    console.log(`[Sequential] Starting ${sourceType.toUpperCase()} processing for ${config.key}`);

    for (const step of steps) {
      try {
        console.log(`[Sequential] Processing step: ${step}`);
        
        const prompt = this.promptManager.createSequentialPrompt('fields', step, contractType, contractNumber);
        const finalPrompt = `${prompt}\n\nContent:\n${content}`;
        
        // Use fast-fail mode after first overload detection to avoid long waits
        const responseText = await this.callGeminiWithRetry(finalPrompt, 3, isGeminiOverloaded);
        const withoutThinkTags = stripThinkTags(responseText);
        const cleanedResponse = this.cleanGeminiJson(withoutThinkTags);
        
        try {
          const stepResult = JSON.parse(cleanedResponse);
          combinedResult = { ...combinedResult, ...stepResult };
          console.log(`[Sequential] Step ${step} completed, ${Object.keys(stepResult).length} fields extracted`);
        } catch (parseErr) {
          console.warn(`[Sequential] Failed to parse step ${step}, skipping:`, parseErr.message);
        }

        // Small delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (err) {
        console.error(`[Sequential] Error in step ${step}:`, err.message);
        
        // If Gemini is overloaded, set flag to use fast-fail mode for remaining steps
        if (err.message === 'GEMINI_OVERLOADED') {
          isGeminiOverloaded = true;
          console.warn('[⚡ Detected Gemini overload - switching to fast-fail mode for remaining steps]');
        }
        
        // Continue with other steps even if one fails
      }
    }

    console.log(`[Sequential] Completed ${sourceType.toUpperCase()} processing, total fields: ${Object.keys(combinedResult).length}`);
    return combinedResult;
  }

  // Process validation in parallel batches
  async processValidation(extractedData, contractType = null, contractNumber = null, sourceType = 'pdf') {
    const validationCategories = [
      'required',
      'business', 
      'deposits',
      'signatures',
      'citizen_id'
    ];

    let allValidations = [];
    
    // Extract contract number from data if not provided
    if (!contractNumber && extractedData && extractedData['Contract Number']) {
      contractNumber = extractedData['Contract Number'];
    }
    
    const config = contractType ? this.promptManager.getContractConfig(contractType, contractNumber) : null;
    console.log(`[Sequential] Starting ${sourceType.toUpperCase()} validation processing${config ? ` for ${config.key}` : ''}`);

    for (const category of validationCategories) {
      try {
        console.log(`[Sequential] Validating category: ${category}`);
        
        const prompt = this.promptManager.createValidationPrompt(category, contractType, contractNumber, sourceType);
        
        // Skip if prompt is null (e.g., web validation skipping signatures)
        if (!prompt) {
          console.log(`[Sequential] Skipping ${category} validation for ${sourceType} data (not applicable)`);
          continue;
        }
        const finalPrompt = `${prompt}\n\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}`;
        
        const responseText = await this.callGeminiWithRetry(finalPrompt);
        const withoutThinkTags = stripThinkTags(responseText);
        const cleanedResponse = this.cleanGeminiJson(withoutThinkTags);
        
        try {
          const validationResult = JSON.parse(cleanedResponse);
          if (Array.isArray(validationResult)) {
            allValidations = [...allValidations, ...validationResult];
            console.log(`[Sequential] Validation ${category} completed, ${validationResult.length} checks`);
          }
        } catch (parseErr) {
          console.warn(`[Sequential] Failed to parse validation ${category}:`, parseErr.message);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (err) {
        console.error(`[Sequential] Error in validation ${category}:`, err.message);
      }
    }

    console.log(`[Sequential] Completed validation processing, total checks: ${allValidations.length}`);
    return allValidations;
  }

  // Process comparison in focused batches  
  async processComparison(pdfData, webData, contractType = null, contractNumber = null) {
    const comparisonCategories = [
      'basic',
      'lease_terms',
      'service_charges', 
      'utilities',
      'tax_deposits'
    ];

    let allComparisons = [];
    
    // Extract contract number from data if not provided
    if (!contractNumber) {
      contractNumber = pdfData?.['Contract Number'] || webData?.['Contract Number'] || null;
    }
    
    const config = contractType ? this.promptManager.getContractConfig(contractType, contractNumber) : null;
    console.log(`[Sequential] Starting comparison processing${config ? ` for ${config.key}` : ''}`);

    for (const category of comparisonCategories) {
      try {
        console.log(`[Sequential] Comparing category: ${category}`);
        
        const prompt = this.promptManager.createComparisonPrompt(category, contractType, contractNumber);
        const sourcesString = `PDF: ${JSON.stringify(pdfData, null, 2)}\n\nWEB: ${JSON.stringify(webData, null, 2)}`;
        const finalPrompt = `${prompt}\n\nSources:\n${sourcesString}`;
        
        // Debug: Log the prompt for basic category to verify context
        if (category === 'basic') {
          console.log(`[Debug] Basic comparison prompt preview:`, prompt.substring(0, 500));
        }
        
        const responseText = await this.callGeminiWithRetry(finalPrompt);
        const withoutThinkTags = stripThinkTags(responseText);
        const cleanedResponse = this.cleanGeminiJson(withoutThinkTags);
        
        try {
          const comparisonResult = JSON.parse(cleanedResponse);
          if (Array.isArray(comparisonResult)) {
            allComparisons = [...allComparisons, ...comparisonResult];
            console.log(`[Sequential] Comparison ${category} completed, ${comparisonResult.length} fields compared`);
          }
        } catch (parseErr) {
          console.warn(`[Sequential] Failed to parse comparison ${category}:`, parseErr.message);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (err) {
        console.error(`[Sequential] Error in comparison ${category}:`, err.message);
      }
    }

    console.log(`[Sequential] Completed comparison processing, total comparisons: ${allComparisons.length}`);
    return allComparisons;
  }

  // Clean Gemini JSON response
  cleanGeminiJson(raw) {
    try {
      if (!raw) return '{}';
  
      let cleaned = raw.trim();
  
      // Remove Markdown triple backticks and optional 'json' hint
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/g, '');
  
      // Remove invalid control characters
      cleaned = cleaned.replace(/[\u0000-\u001F\u007F]/g, '');
  
      // Normalize smart quotes to standard quotes
      cleaned = cleaned.replace(/[""]/g, '"').replace(/['']/g, "'");
  
      // Escape lone backslashes (those not followed by escape characters)
      cleaned = cleaned.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  
      // Remove trailing commas before closing braces/brackets
      cleaned = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  
      return cleaned;
    } catch (err) {
      console.error('[cleanGeminiJson] ERROR:', err.message);
      return raw;
    }
  }

  // Legacy method for backward compatibility
  async processLegacy(content, contractType, sourceType = 'pdf') {
    console.log(`[Sequential] Using legacy processing for ${contractType}`);
    
    const prompt = this.promptManager.createLegacyExtractionPrompt(contractType);
    const finalPrompt = `${prompt}\n\nContent:\n${content}`;
    
    const responseText = await this.callGeminiWithRetry(finalPrompt);
    const withoutThinkTags = stripThinkTags(responseText);
    return this.cleanGeminiJson(withoutThinkTags);
  }
}

export default SequentialProcessor;