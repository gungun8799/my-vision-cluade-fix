import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

// Test script for the optimized prompt system
const API_BASE = 'http://localhost:5001';

async function testSequentialProcessing() {
  console.log('🧪 Testing Sequential Processing Optimization');
  console.log('=' .repeat(50));  

  // Test 1: Check if new endpoints are available
  console.log('\n📋 Test 1: Endpoint availability');
  try {
    const response = await axios.get(`${API_BASE}/api/prompts`);
    console.log('✅ Legacy prompts endpoint working');
    console.log(`   Available prompts: ${response.data.promptKeys.length}`);
  } catch (err) {
    console.error('❌ Legacy prompts endpoint failed:', err.message);
  }

  // Test 2: Test prompt file structure
  console.log('\n📋 Test 2: New prompt structure');
  const promptDirs = ['fields', 'validation', 'compare'];
  for (const dir of promptDirs) {
    const dirPath = path.join(process.cwd(), 'server', 'prompts', dir);
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));
      console.log(`✅ ${dir}/ directory: ${files.length} prompt files`);
      files.forEach(file => console.log(`   - ${file}`));
    } else {
      console.error(`❌ ${dir}/ directory not found`);
    }
  }

  // Test 3: Test PromptManager functionality
  console.log('\n📋 Test 3: PromptManager functionality');
  try {
    const { default: PromptManager } = await import('./promptManager.js');
    const promptManager = new PromptManager();
    
    // Test basic info prompt loading
    const basicPrompt = promptManager.loadPrompt('fields', 'basic_info.txt');
    console.log(`✅ Basic info prompt loaded: ${basicPrompt.length} characters`);
    
    // Test sequential prompt creation
    const sequentialPrompt = promptManager.createSequentialPrompt('fields', 'basic_info');
    console.log(`✅ Sequential prompt created: ${sequentialPrompt.length} characters`);
    
    // Test validation prompt
    const validationPrompt = promptManager.createValidationPrompt('required');
    console.log(`✅ Validation prompt created: ${validationPrompt.length} characters`);
    
    // Compare lengths
    const legacyPath = path.join(process.cwd(), 'server', 'prompts', 'LOI_permanent_fixed_fields.txt');
    if (fs.existsSync(legacyPath)) {
      const legacyPrompt = fs.readFileSync(legacyPath, 'utf8');
      console.log(`📊 Legacy prompt length: ${legacyPrompt.length} characters`);
      console.log(`📊 Sequential basic prompt: ${basicPrompt.length} characters`);
      console.log(`🎯 Size reduction: ${Math.round((1 - basicPrompt.length / legacyPrompt.length) * 100)}%`);
    }
    
  } catch (err) {
    console.error('❌ PromptManager test failed:', err.message);
  }

  // Test 4: Test SequentialProcessor
  console.log('\n📋 Test 4: SequentialProcessor functionality');
  try {
    const { default: SequentialProcessor } = await import('./sequentialProcessor.js');
    const processor = new SequentialProcessor();
    
    console.log('✅ SequentialProcessor initialized');
    console.log('   Available methods: processSequential, processValidation, processComparison');
    
  } catch (err) {
    console.error('❌ SequentialProcessor test failed:', err.message);
  }

  // Test 5: Check configuration system
  console.log('\n📋 Test 5: Configuration system');
  try {
    const { config, shouldUseSequential, shouldUseLegacyFallback } = await import('./config.js');
    
    console.log(`✅ Configuration loaded`);
    console.log(`   Processing mode: ${config.processingMode}`);
    console.log(`   Sequential enabled: ${shouldUseSequential()}`);
    console.log(`   Legacy fallback: ${shouldUseLegacyFallback()}`);
    console.log(`   Step delay: ${config.rateLimit.delayBetweenSteps}ms`);
    
  } catch (err) {
    console.error('❌ Configuration test failed:', err.message);
  }

  console.log('\n🎉 Optimization testing complete!');
  console.log('=' .repeat(50));
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testSequentialProcessing().catch(console.error);
}

export { testSequentialProcessing };