import fs from 'fs';
import path from 'path';

class PromptManager {
  constructor() {
    // Check if we're already in the server directory or need to navigate to it
    const currentDir = process.cwd();
    if (currentDir.endsWith('server')) {
      this.promptsDir = path.join(currentDir, 'prompts');
    } else {
      this.promptsDir = path.join(currentDir, 'server', 'prompts');
    }
    console.log(`[PromptManager] Using prompts directory: ${this.promptsDir}`);
  }

  // Load a prompt file from the new structure
  loadPrompt(contractType, category, filename) {
    const promptPath = path.join(this.promptsDir, contractType, category, filename);
    console.log(`[📁 Loading prompt file] ${contractType}/${category}/${filename}`);
    console.log(`[🗂️ Full path] ${promptPath}`);
    if (!fs.existsSync(promptPath)) {
      throw new Error(`Prompt file not found: ${contractType}/${category}/${filename}`);
    }
    const content = fs.readFileSync(promptPath, 'utf8');
    console.log(`[✅ Prompt loaded] ${content.length} characters from ${contractType}/${category}/${filename}`);
    return content;
  }

  // Detect contract number type (LO or LR)
  detectContractNumberType(contractNumber) {
    if (!contractNumber) return 'unknown';
    const upperContract = contractNumber.toUpperCase();
    if (upperContract.includes('LO')) return 'LO';
    if (upperContract.includes('LR')) return 'LR';
    return 'unknown';
  }

  // Get contract configuration based on type and number
  getContractConfig(contractType, contractNumber) {
    const numberType = this.detectContractNumberType(contractNumber);
    
    return {
      contractType,
      numberType,
      key: `${contractType}_${numberType}`,
      isServiceExpress: contractType === 'service_express',
      isPermanentFixed: contractType === 'permanent_fixed',
      isLO: numberType === 'LO',
      isLR: numberType === 'LR'
    };
  }

  // Create a sequential extraction prompt (for step-by-step processing)
  createSequentialPrompt(category, step, contractType = null, contractNumber = null) {
    if (!contractType) {
      throw new Error('Contract type is required for sequential prompts');
    }

    const stepPrompts = {
      basic_info: 'basic_info.txt',
      tenant_info: 'tenant_info.txt',
      lease_terms: 'lease_terms.txt',
      service_charges: 'service_charges.txt',
      utilities: 'utilities.txt',
      signatures: 'signatures.txt'
    };

    if (!stepPrompts[step]) {
      throw new Error(`Unknown extraction step: ${step}`);
    }

    const filename = stepPrompts[step];
    const prompt = this.loadPrompt(contractType, 'fields', filename);
    
    // Add contract context information
    const config = this.getContractConfig(contractType, contractNumber);
    const contextHeader = `\n--- CONTRACT CONTEXT ---\nContract Type: ${config.contractType.replace('_', ' ').toUpperCase()}\nContract Number Type: ${config.numberType}\n---\n`;
    
    return contextHeader + prompt;
  }

  // Create validation prompt for specific category and source type
  createValidationPrompt(category, contractType = null, contractNumber = null, sourceType = 'pdf') {
    if (!contractType) {
      throw new Error('Contract type is required for validation prompts');
    }

    const validationCategories = {
      required: 'required_fields.txt',
      business: 'business_rules.txt', 
      deposits: 'deposit_rules.txt',
      signatures: 'signature_validation.txt',
      individual_validation: 'individual_validation.txt',
      corporate_validation: 'corporate_validation.txt',
      data_completeness: 'data_completeness.txt'
    };

    if (!validationCategories[category]) {
      throw new Error(`Unknown validation category: ${category}`);
    }

    const filename = validationCategories[category];
    const validationType = sourceType === 'web' ? 'web_validation' : 'pdf_validation';
    
    // For web validation, skip signature and citizen ID categories as they're not available in web data
    if (sourceType === 'web' && (category === 'signatures' || category === 'individual_validation' || category === 'corporate_validation')) {
      console.log(`[PromptManager] Skipping ${category} validation for web data (not available)`);
      return null;
    }
    
    const prompt = this.loadPrompt(contractType, validationType, filename);
    
    // Add contract context for validation
    const config = this.getContractConfig(contractType, contractNumber);
    const contextHeader = `\n--- VALIDATION CONTEXT ---\nContract Type: ${config.contractType.replace('_', ' ').toUpperCase()}\nContract Number Type: ${config.numberType}\nSource Type: ${sourceType.toUpperCase()}\n---\n`;
    
    return contextHeader + prompt;
  }

  // Create comparison prompt for specific category
  createComparisonPrompt(category, contractType = null, contractNumber = null) {
    if (!contractType) {
      throw new Error('Contract type is required for comparison prompts');
    }

    console.log(`[🔍 Creating comparison prompt] Category: ${category}, ContractType: ${contractType}, ContractNumber: ${contractNumber}`);

    const comparisonCategories = {
      basic: 'basic_fields.txt',
      lease_terms: 'lease_terms.txt',
      lease_basic: 'lease_basic.txt',
      lease_years: 'lease_years.txt',
      service_charges: 'service_charges.txt',
      utilities: 'utilities.txt',
      tax_deposits: 'tax_deposits.txt'
    };

    if (!comparisonCategories[category]) {
      throw new Error(`Unknown comparison category: ${category}`);  
    }

    const filename = comparisonCategories[category];
    let prompt = this.loadPrompt(contractType, 'compare', filename);
    
    // Add contract context for comparison
    const config = this.getContractConfig(contractType, contractNumber);
    console.log(`[📋 Contract Config] Type: ${config.contractType}, NumberType: ${config.numberType}, IsLR: ${config.isLR}, ContractNumber: ${contractNumber}`);
    
    // Add LR-specific rules only for LR contracts in basic category
    if (category === 'basic' && config.isLR) {
      let lrRules = `

**SPECIAL LR CONTRACT RULES (Applied because this is an LR contract):**
- "Customer Address": Automatically mark as match: true with reason "LR contract - address comparison skipped"
- "Billing Frequency": If web value is NULL, mark as match: true with reason "LR contract - billing frequency validation relaxed"
`;
      
      // Add service express specific LR rules
      if (config.isServiceExpress) {
        lrRules += `- "Unit ID": Automatically mark as match: true with reason "LR contract - Unit ID comparison skipped"
`;
      }
      
      prompt = prompt + lrRules;
      console.log(`[📋 Added LR-specific rules for LR contract: ${contractNumber}]`);
    }
    
    const contextHeader = `\n--- COMPARISON CONTEXT ---\nContract Type: ${config.contractType.replace('_', ' ').toUpperCase()}\nContract Number Type: ${config.numberType}\nContract Number: ${contractNumber || 'unknown'}\n---\n`;
    
    const finalPrompt = contextHeader + prompt;
    console.log(`[✅ Comparison prompt created] ${finalPrompt.length} characters for ${category}`);
    
    return finalPrompt;
  }

  // Legacy support - create full extraction prompt (backward compatibility)
  createLegacyExtractionPrompt(contractType) {
    if (!contractType) {
      throw new Error('Contract type is required for legacy prompts');
    }

    const steps = ['basic_info', 'tenant_info', 'lease_terms', 'service_charges', 'utilities', 'signatures'];
    const prompts = [];
    
    for (const step of steps) {
      try {
        const prompt = this.createSequentialPrompt('fields', step, contractType, null);
        prompts.push(prompt);
      } catch (err) {
        console.warn(`[PromptManager] Could not load step ${step} for legacy prompt: ${err.message}`);
      }
    }
    
    // Add JSON format enforcement at the end
    const jsonEnforcement = '\n\nIMPORTANT: Return your response as a single valid JSON object containing all the extracted fields. Do not include any explanatory text before or after the JSON.';
    
    return prompts.join('\n\n--- NEXT SECTION ---\n\n') + jsonEnforcement;
  }

  // Assemble extraction prompts based on contract type (legacy compatibility)
  assembleExtractionPrompts(contractType) {
    console.warn('[PromptManager] assembleExtractionPrompts is deprecated, use createSequentialPrompt instead');
    return [this.createLegacyExtractionPrompt(contractType)];
  }

  // Assemble validation prompts (legacy compatibility)
  assembleValidationPrompts(contractType = 'permanent_fixed', sourceType = 'pdf') {
    console.warn('[PromptManager] assembleValidationPrompts is deprecated, use createValidationPrompt instead');
    const categories = ['required', 'business', 'deposits', 'signatures', 'individual_validation', 'corporate_validation'];
    const prompts = [];
    
    for (const category of categories) {
      try {
        const prompt = this.createValidationPrompt(category, contractType, null, sourceType);
        if (prompt) { // Skip null prompts (e.g., web validation skipping signatures)
          prompts.push(prompt);
        }
      } catch (err) {
        console.warn(`[PromptManager] Could not load validation ${category}: ${err.message}`);
      }
    }
    
    return prompts;
  }

  // Assemble comparison prompts (legacy compatibility)
  assembleComparisonPrompts(contractType = 'permanent_fixed') {
    console.warn('[PromptManager] assembleComparisonPrompts is deprecated, use createComparisonPrompt instead');
    const categories = ['basic', 'lease_terms', 'service_charges', 'utilities', 'tax_deposits'];
    const prompts = [];
    
    for (const category of categories) {
      try {
        const prompt = this.createComparisonPrompt(category, contractType);
        prompts.push(prompt);
      } catch (err) {
        console.warn(`[PromptManager] Could not load comparison ${category}: ${err.message}`);
      }
    }
    
    return prompts;
  }
}

export default PromptManager;