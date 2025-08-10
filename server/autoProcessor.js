import puppeteer from 'puppeteer';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { shouldUseSequential, shouldUseLegacyFallback, logInfo } from './config.js';

// ===== UTILITY FUNCTION TO STRIP THINK TAGS =====
function stripThinkTags(response) {
  if (!response || typeof response !== 'string') {
    return response;
  }
  
  console.log('[DEBUG stripThinkTags] Input length:', response.length);
  console.log('[DEBUG stripThinkTags] First 200 chars:', response.substring(0, 200));
  console.log('[DEBUG stripThinkTags] Last 200 chars:', response.substring(response.length - 200));
  
  // First, remove properly closed <think>...</think> tags
  let cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // For unclosed think tags, try to preserve JSON content that comes after
  if (cleaned.includes('<think>')) {
    console.log('[DEBUG stripThinkTags] Found unclosed think tag');
    
    // Remove the unclosed think tag and everything before it
    cleaned = cleaned.replace(/^[\s\S]*?<think>[\s\S]*?(?=[\[\{])/i, '');
  }
  
  // Try to extract valid JSON using bracket/brace counting
  const extractedJson = extractValidJson(cleaned);
  if (extractedJson) {
    console.log('[DEBUG stripThinkTags] Successfully extracted JSON using bracket counting');
    cleaned = extractedJson;
  }
  
  const result = cleaned.trim();
  console.log('[DEBUG stripThinkTags] Output length:', result.length);
  console.log('[DEBUG stripThinkTags] Output preview:', result.substring(0, 200));
  
  return result;
}

function extractValidJson(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  
  // Look for potential JSON start positions - arrays or objects
  const potentialStarts = [];
  
  // Find all potential array starts
  let pos = 0;
  while ((pos = text.indexOf('[', pos)) !== -1) {
    potentialStarts.push({ pos, type: 'array' });
    pos++;
  }
  
  // Find all potential object starts
  pos = 0;
  while ((pos = text.indexOf('{', pos)) !== -1) {
    potentialStarts.push({ pos, type: 'object' });
    pos++;
  }
  
  // Sort by position
  potentialStarts.sort((a, b) => a.pos - b.pos);
  
  // Try each potential start position
  for (const start of potentialStarts) {
    console.log(`[DEBUG extractValidJson] Trying ${start.type} at position ${start.pos}`);
    
    const jsonStr = tryExtractJsonFromPosition(text, start.pos, start.type === 'array');
    if (jsonStr) {
      console.log(`[DEBUG extractValidJson] Successfully extracted JSON from position ${start.pos}`);
      return jsonStr;
    }
  }
  
  console.log('[DEBUG extractValidJson] No valid JSON found');
  return null;
}

function tryExtractJsonFromPosition(text, startPos, isArray) {
  const openChar = isArray ? '[' : '{';
  const closeChar = isArray ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = startPos; i < text.length; i++) {
    const char = text[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === openChar) {
        depth++;
      } else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          // Found complete JSON candidate
          const jsonStr = text.substring(startPos, i + 1);
          console.log(`[DEBUG tryExtractJsonFromPosition] Found complete structure, length: ${jsonStr.length}`);
          
          // Validate it's actually valid JSON
          try {
            const parsed = JSON.parse(jsonStr);
            
            // For arrays, make sure it contains objects (validation results)
            if (isArray && Array.isArray(parsed) && parsed.length > 0) {
              // Check if first element looks like a validation result
              const firstElement = parsed[0];
              if (typeof firstElement === 'object' && 
                  firstElement !== null && 
                  ('field' in firstElement || 'status' in firstElement || 'match' in firstElement)) {
                console.log('[DEBUG tryExtractJsonFromPosition] Array contains validation-like objects');
                return jsonStr;
              }
            }
            
            // For objects, accept if it parses correctly
            if (!isArray && typeof parsed === 'object' && parsed !== null) {
              console.log('[DEBUG tryExtractJsonFromPosition] Valid object found');
              return jsonStr;
            }
            
            console.log('[DEBUG tryExtractJsonFromPosition] JSON structure doesn\'t look like validation data');
          } catch (e) {
            console.log('[DEBUG tryExtractJsonFromPosition] JSON validation failed:', e.message);
          }
          
          return null; // This position didn't work, but don't continue counting
        }
      }
    }
  }
  
  return null; // Incomplete structure
}

const FOLDER_PATH = path.join(process.cwd(), 'contracts');

// === 🔁 Create dated output folders ===
const now = new Date();
const dateFolder = now.toISOString().split('T')[0]; // Only date part: 'YYYY-MM-DD'
const OUTPUT_BASE = path.join(process.cwd(), 'processed', dateFolder);
const PASSED_FOLDER = path.join(OUTPUT_BASE, 'verification_passed');
const FAILED_FOLDER = path.join(OUTPUT_BASE, 'verification_failed');
const SKIPPED_FOLDER = path.join(OUTPUT_BASE, 'skipped');

for (const folder of [PASSED_FOLDER, FAILED_FOLDER, SKIPPED_FOLDER]) {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    console.log(`[📁 Folder Created] ${folder}`);
  }
}

/*************  ✨ Windsurf Command ⭐  *************/
  /**
   * Processes all PDF files in the `contracts` folder and moves them to `processed/verification_passed` or `processed/verification_failed` based on whether the contract was confirmed.
   * Skips any files with invalid filenames (not matching the expected pattern of digits_(LO|LR)digits_digits.pdf).
   * Logs and continues if the file has already been processed (i.e. already exists in the output folders).
   * If the file is skipped due to an invalid filename or already having been processed, optionally moves it to the `skipped` folder.
   * Waits 90 seconds between processing each file.
   * @returns {Promise<void>}
   */
/*******  99d33ffb-ad84-4ce2-b05f-eda43bb739a2  *******/async function processContractsInFolder() {
  const files = fs.readdirSync(FOLDER_PATH).filter(f => f.toLowerCase().endsWith('.pdf'));

  for (const file of files) {
    // ── 0) If the base name (without ".pdf") does NOT match digits_(LO|LR)digits_digits, skip immediately ──
    const baseName = file.replace(/\.pdf$/i, '');
    const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
    if (!validPattern.test(baseName)) {
      console.log(`[⏭️ Skip Invalid Filename] ${file} does not match expected pattern.`);
      // Optionally, move it to SKIPPED_FOLDER or just log and continue:
      // await delayedMove(file, SKIPPED_FOLDER);
      continue;
    }

    // ── 1) Check if file already processed ──
    const alreadyProcessed = await checkIfFileExistsInFirebase(baseName);
    if (alreadyProcessed) {
      console.log(`[⏭️ Skip Confirmed] ${file} – already processed and up to date.`);

      const filePath = path.join(FOLDER_PATH, file);
      if (fs.existsSync(filePath)) {
        console.log(`[🧪 Moving skipped file] Calling delayedMove()`);
        await delayedMove(file, SKIPPED_FOLDER);
      } else {
        console.warn(`[⚠️ Skipped file not found] ${file} already missing from contracts folder.`);
      }

      continue;
    }

    console.log(`[📄 Processing] ${file}`);
    const success = await processOneContract(file);

    const destFolder = success ? PASSED_FOLDER : FAILED_FOLDER;
    await delayedMove(file, destFolder);

    console.log('[⏳] Waiting for 90 seconds before processing the next file...');
    await new Promise(resolve => setTimeout(resolve, 90000));
  }

  console.log('[✅] All files processed.');
}

async function delayedMove(filename, destinationFolder) {
  const src = path.join(FOLDER_PATH, filename);
  const dest = path.join(destinationFolder, filename);

  console.log(`[🕒 Waiting 3s before moving file] ${filename}`);
  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    console.log(`[🛆 Attempting rename] ${src} → ${dest}`);
    await fsPromises.rename(src, dest);
    console.log(`[✅ File Moved] ${filename} → ${destinationFolder}`);
  } catch (err) {
    console.error(`[❌ Rename failed] ${filename}: ${err.message}`);
    try {
      await fsPromises.copyFile(src, dest);
      await fsPromises.unlink(src);
      console.log(`[✅ Fallback Copy+Delete] ${filename} → ${destinationFolder}`);
    } catch (copyErr) {
      console.error(`[❌ Fallback Copy+Delete failed] ${filename}: ${copyErr.message}`);
    }
  }
}

// Single file handler with internal file move logic
async function processOneContract(filename) {
  const filePath = path.join(FOLDER_PATH, filename);
  const contractNumberRaw = path.basename(filename, '.pdf');
  if (!fs.existsSync(filePath)) {
    console.error(`[❌ File Not Found] ${filePath}`);
    return false;
  }

  try {
    // ─── Step 1: OCR & contract‐type classification ──────────────────────
    const ocrForm = new FormData();
    ocrForm.append('file', fs.createReadStream(filePath));
    ocrForm.append('pages', 'all');

    const ocrRes = await axios.post('http://localhost:5001/api/extract-text-only', ocrForm, {
      headers: ocrForm.getHeaders(),
    });
    const ocrText = ocrRes.data?.text;
    if (!ocrText) throw new Error('No OCR text received from /api/extract-text-only');

    const classifyRes = await axios.post('http://localhost:5001/api/contract-classify', { ocrText });
    const contractType = classifyRes.data?.contractType || 'unknown';
    console.log(`[🔍 Contract Type Detected] ${contractType}`);
    console.log(`[📌 Using modular prompts for contract type] ${contractType}`);

    // ─── Step 2: Sequential PDF Processing ───────────────
    console.log('[🔁 Calling /api/extract-text-sequential for OCR & Gemini]');
    const extractForm = new FormData();
    // Append the PDF under "files" (match upload.array('files'))
    extractForm.append(
      'files',
      fs.createReadStream(filePath),
      path.basename(filePath)
    );
    // Ensure pages is provided
    extractForm.append('pages', 'all');
    extractForm.append('contractType', contractType);

    // 2.1) Extract text + Gemini processing (with configuration)
    let extractRes;
    const useSequential = shouldUseSequential();
    const useFallback = shouldUseLegacyFallback();
    
    logInfo(`Processing mode - Sequential: ${useSequential}, Fallback: ${useFallback}`);
    
    if (useSequential) {
      try {
        logInfo('Attempting sequential processing');
        extractRes = await axios.post(
          'http://localhost:5001/api/extract-text-sequential',
          extractForm,
          { 
            headers: extractForm.getHeaders(),
            timeout: 10800000 // 3 hours timeout (effectively infinite) for response for large PDF processing
          }
        );
        logInfo('Sequential processing successful');
      } catch (err) {
        console.warn('[⚠️ Sequential processing failed]', err.response?.data || err.message);
        
        if (useFallback) {
          console.log('[🔄 Falling back to legacy processing]');
          // Fallback to legacy processing
          // contractType already appended at line 138
          try {
            extractRes = await axios.post(
              'http://localhost:5001/api/extract-text',
              extractForm,
              { 
                headers: extractForm.getHeaders(),
                timeout: 10800000 // 3 hours timeout (effectively infinite) for response for large PDF processing
              }
            );
            console.log('[✅ Legacy fallback successful]');
          } catch (legacyErr) {
            console.error('[❌ Both sequential and legacy processing failed]', legacyErr.response?.data || legacyErr.message);
            throw legacyErr;
          }
        } else {
          throw err;
        }
      }
    } else {
      // Use legacy processing directly
      logInfo('Using legacy processing (sequential disabled)');
      // contractType already appended at line 138
      extractRes = await axios.post(
        'http://localhost:5001/api/extract-text',
        extractForm,
        { headers: extractForm.getHeaders() }
      );
    }
    
    const geminiOut = extractRes.data.geminiOutput
    let parsedPdf = extractRes.data.extractedData || null
    const processingMethod = extractRes.data.processingMethod || 'legacy'
    console.log(`[✅ Backend extract complete using ${processingMethod} method]`)

    // 2.2) Parse out the Contract Number from Gemini output  
    if (!parsedPdf) {
      // Legacy processing - need to parse JSON
      try {
        // Check if response is plain text instead of JSON
        if (geminiOut && !geminiOut.trim().includes('{') && !geminiOut.trim().includes('[')) {
          console.error('[❌ Gemini returned plain text instead of JSON]');
          console.error('[📝 Gemini response preview]:', geminiOut.substring(0, 200));
          throw new Error('Gemini API returned plain text instead of JSON. The model may be overloaded or the prompt may be unclear.');
        }
        
        const cleaned = cleanGeminiJson(geminiOut);
        parsedPdf = JSON.parse(cleaned);
      } catch (e) {
        console.error('[❌ Failed to parse Gemini JSON]', e.message);
        console.error('[📝 Raw Gemini output]:', geminiOut?.substring(0, 300));
        throw e;
      }
    }
    const extractedContractNumber = parsedPdf['Contract Number'] || parsedPdf['Contract number'] || 'unknown_contract'
    const contractId = typeof extractedContractNumber === 'string' ? extractedContractNumber.replace(/\//g, '_') : 'unknown_contract'
    console.log(`[🔖 Extracted Contract Number] ${extractedContractNumber}`)
    
    if (extractedContractNumber === 'unknown_contract') {
      console.warn('[⚠️ No contract number extracted, using fallback]')
    }

    // 2.3) Auto-login to Simplicity before scraping
    console.log(`[🔐 Ensuring Simplicity login before auto-scrape for ${extractedContractNumber}]`)
    try {
      const loginRes = await axios.post('http://localhost:5001/api/scrape-login', {
        systemType: 'simplicity',
        username: 'wisarut.gunjarueg@lotuss.com',
        password: 'GunHarvey@2475'
      }, {
        timeout: 0 // No timeout - wait indefinitely
      });
      
      if (!loginRes.data.success) {
        console.warn('[⚠️ Auto-login failed, but continuing with scraping]', loginRes.data.message);
      } else {
        console.log('[✅ Auto-login to Simplicity successful]');
      }
    } catch (loginError) {
      console.warn('[⚠️ Auto-login error, but continuing with scraping]', loginError.message);
    }

    // 2.4) Sequential Auto‐scrape Simplicity for the extracted contract
    console.log(`[🔐 Auto-scrape for ${extractedContractNumber}]`)
    let scrapeRes;
    let parsedWeb = null;
    
    if (processingMethod === 'sequential') {
      console.log('[🔄 Using sequential web scraping]');
      try {
        scrapeRes = await axios.post('http://localhost:5001/api/scrape-url-sequential', {
          systemType: 'simplicity',
          contractType,
          contractNumber: extractedContractNumber,
        }, {
          timeout: 0 // No timeout - wait indefinitely
        });
        parsedWeb = scrapeRes.data.extractedData;
        console.log('[✅ Sequential web scrape complete]');
      } catch (err) {
        console.warn('[⚠️ Sequential web scraping failed, falling back to legacy]', err.response?.data || err.message);
        // Fallback to legacy scraping
        scrapeRes = await axios.post('http://localhost:5001/api/scrape-url', {
          systemType: 'simplicity',
          contractType,
          contractNumber: extractedContractNumber,
        }, {
          timeout: 0 // No timeout - wait indefinitely
        });
      }
    } else {
      // Legacy scraping
      console.log('[🔄 Using legacy web scraping]');
      scrapeRes = await axios.post('http://localhost:5001/api/scrape-url', {
        systemType: 'simplicity',
        contractType,
        contractNumber: extractedContractNumber,
      }, {
        timeout: 0 // No timeout - wait indefinitely
      });
    }
    
    if (!scrapeRes.data.success) {
      throw new Error(`Scrape-URL failed: ${scrapeRes.data.message}`)
    }
    const webGeminiRaw = scrapeRes.data.geminiOutput

    console.log('[✅ Web scrape complete]')


    // TESTING 
    // function cleanGeminiJson(raw) {
    //   if (!raw) return '{}';

    //   let t = raw.trim();

    //   // Remove markdown code fences
    //   if (t.startsWith("```json")) t = t.slice(7);
    //   if (t.startsWith("```")) t = t.slice(3);
    //   if (t.endsWith("```")) t = t.slice(0, -3);

    //   // Remove control characters
    //   t = t.replace(/[\u0000-\u001F]+/g, '');

    //   // Remove any invalid trailing commas
    //   t = t.replace(/,\s*([}\]])/g, '$1');

    //   // Escape any standalone backslashes
    //   t = t.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');

    //   // Optional: normalize smart quotes (in case Gemini adds them)
    //   t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

    //   return t;
    // } 
    function cleanGeminiJson(raw) {
      try {
        if (!raw) return '{}';
    
        let cleaned = raw.trim();
        
        // Check for multiple JSON blocks pattern
        const jsonBlockPattern = /```json\s*(\{[\s\S]*?\})\s*```/gi;
        const matches = [...cleaned.matchAll(jsonBlockPattern)];
        
        if (matches.length > 1) {
          console.log(`[🔍 Detected ${matches.length} JSON blocks, merging them]`);
          
          // Merge multiple JSON objects into one
          let mergedObject = {};
          
          for (const match of matches) {
            try {
              const jsonStr = match[1].trim();
              const parsedBlock = JSON.parse(jsonStr);
              
              // Merge this block into the main object
              mergedObject = { ...mergedObject, ...parsedBlock };
            } catch (blockErr) {
              console.warn('[⚠️ Failed to parse individual JSON block]', blockErr.message);
            }
          }
          
          return JSON.stringify(mergedObject);
        }
    
        // Single block processing (existing logic)
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
    
    // 2.X: Parse Web Gemini Output (if not already parsed)
    if (!parsedWeb) {
      // Legacy processing - need to parse JSON
      try {
        // Clean up raw Gemini response for web source
        const cleanedWebGemini = cleanGeminiJson(webGeminiRaw);
      
        // Attempt to isolate valid JSON section from cleaned output
        const b1 = cleanedWebGemini.indexOf('{');
        const b2 = cleanedWebGemini.lastIndexOf('}');
        const jsonString = cleanedWebGemini.slice(b1, b2 + 1);
      
        console.log('[🧪 Cleaned Web Gemini JSON Preview]', jsonString.slice(0, 300));
        parsedWeb = JSON.parse(jsonString);
      } catch (e) {
        console.error('[❌ Failed to parse web Gemini JSON]', e.message);
        console.log('[🧨 Original Gemini Output]', webGeminiRaw);
        throw new Error('Failed to parse web Gemini JSON: ' + e.message);
      }
    }
    
    // 2.5) Sequential Comparison
    let compareResult;
    if (processingMethod === 'sequential') {
      console.log('[🔄 Using sequential comparison]');
      try {
        const cmpRes = await axios.post('http://localhost:5001/api/compare-sequential', {
          pdfData: parsedPdf,
          webData: parsedWeb,
          contractType,
          contractNumber: extractedContractNumber,
        }, {
          timeout: 10800000 // 3 hours timeout (effectively infinite) for comparison response
        });
        compareResult = cmpRes.data.comparison;
        console.log('[✅ Sequential comparison complete]');
      } catch (err) {
        console.warn('[⚠️ Sequential comparison failed, falling back to legacy]', err.message);
        // Fallback to legacy comparison
        const formattedSources = { pdf: parsedPdf, web: parsedWeb };
        const cmpRes = await axios.post('http://localhost:5001/api/gemini-compare', {
          formattedSources,
          contractType,
          contractNumber: extractedContractNumber,
        });
        const rawOutput = cmpRes.data.response;
        const cleaned = cleanGeminiJson(rawOutput);
        compareResult = JSON.parse(cleaned);
      }
    } else {
      // Legacy comparison
      console.log('[🔄 Using legacy comparison]');
      const formattedSources = { pdf: parsedPdf, web: parsedWeb };
      const cmpRes = await axios.post('http://localhost:5001/api/gemini-compare', {
        formattedSources,
        contractType,
        contractNumber: extractedContractNumber,
      }, {
        timeout: 10800000 // 3 hours timeout (effectively infinite) for comparison response
      });
      
      const rawOutput = cmpRes.data.response;
      
      // Check if response is already a JSON string (from chunked Lotus)
      let cleaned = rawOutput;
      if (typeof rawOutput === 'string' && !rawOutput.trim().startsWith('[')) {
        cleaned = cleanGeminiJson(rawOutput);
      }
      
      try {
        compareResult = JSON.parse(cleaned);
      } catch (err) {
        console.error('[❌ Failed to parse sanitized compare JSON]', err.message);
        console.error('[🧨 Raw Compare Gemini Output]', rawOutput);
      
        // 🩹 Aggressive patch for unterminated "reason": "
        let patched = cleaned.replace(/"reason"\s*:\s*"[^"]*$/g, '"reason": ""');
      
        // ✅ Truncate the string at the last closing array bracket
        const endIndex = patched.lastIndexOf(']');
        if (endIndex !== -1) {
          patched = patched.slice(0, endIndex + 1);
        }
      
        try {
          compareResult = JSON.parse(patched);
          console.warn('[⚠️ JSON parse succeeded after aggressive patch]');
        } catch (finalErr) {
          console.error('[❌ JSON still invalid after patch]', finalErr.message);
          throw finalErr;
        }
      }
    }


    // 2.7) Modular Document Validation
    console.log('[🔄 Using modular validation]');
    let validationResult;
    try {
      const docValRes = await axios.post('http://localhost:5001/api/validate-modular', {
        extractedData: parsedPdf,
        contractType,
        contractNumber: extractedContractNumber,
        sourceType: 'pdf',
      }, {
        timeout: 10800000 // 3 hours timeout (effectively infinite) for validation response
      });
      validationResult = docValRes.data.validation;
      console.log('[✅ Modular validation complete]');
    } catch (err) {
      console.error('[❌ Modular validation failed]', err.message);
      throw err;
    }
    
    await axios.post('http://localhost:5001/api/save-validation-result', {
      contractNumber: contractId,
      validationResult,
    });
    console.log('[✅ Saved validation_result]');

    // 2.8) Modular Web Validation  
    console.log('[🔄 Using modular web validation]');
    let webValidation;
    try {
      const webValRes = await axios.post('http://localhost:5001/api/validate-modular', {
        extractedData: parsedWeb,
        contractType,
        contractNumber: extractedContractNumber,
        sourceType: 'web',
      }, {
        timeout: 10800000 // 3 hours timeout (effectively infinite) for web validation response
      });
      webValidation = webValRes.data.validation;
      console.log('[✅ Modular web validation complete]');
    } catch (err) {
      console.error('[❌ Modular web validation failed]', err.message);
      throw err;
    }
    
    if (Array.isArray(webValidation)) {
      await axios.post('http://localhost:5001/api/save-validation-result', {
        contractNumber: contractId,
        validationResult: webValidation,
      });
      console.log('[✅ Saved web_validation_result]');
    } else {
      console.warn('[⚠️ Web validation returned no array; skipping save]');
    }

    // 2.10) METER CHECK - Check if meter validation should be performed
    console.log('[🔧 AutoProcessor] Checking if meter validation needed...');
    console.log('[🔧 AutoProcessor] parsedWeb["Include Utility"]:', parsedWeb['Include Utility']);
    console.log('[🔧 AutoProcessor] extractedContractNumber:', extractedContractNumber);
    console.log('[🔧 AutoProcessor] contractNumber.includes("LO"):', extractedContractNumber.includes('LO'));
    
    // Check for variations in utility field name and value
    const utilityValue = parsedWeb['Include Utility'] || parsedWeb['Utility'] || parsedWeb['Include utility'];
    const isUtilityYes = utilityValue && (utilityValue.toLowerCase() === 'yes' || utilityValue.toLowerCase().includes('yes'));
    
    console.log('[🔧 AutoProcessor] utilityValue (normalized):', utilityValue);
    console.log('[🔧 AutoProcessor] isUtilityYes:', isUtilityYes);
    
    let meterValidation = null;
    if (isUtilityYes && extractedContractNumber.includes('LO')) {
      console.log('[🔧 AutoProcessor] Include Utility=Yes & LO → triggering meter check...');
      
      try {
        // Call the meter check endpoint (which should exist in server.js)
        const meterResponse = await axios.post('http://localhost:5001/api/meter-check', {
          contractNumber: extractedContractNumber,
          contractType: contractType,
          unitId: parsedWeb['Unit ID'] || '',
          buildingId: parsedWeb['Building ID'] || ''
        }, {
          timeout: 10800000 // 3 hours timeout (effectively infinite) for response
        });
        
        if (meterResponse.data.success) {
          console.log('[🔧 AutoProcessor] Meter check completed successfully');
          console.log('[🔧 AutoProcessor] meterResponse.data.meterValidation:', meterResponse.data.meterValidation);
          meterValidation = meterResponse.data.meterValidation;
          console.log('[🔧 AutoProcessor] meterValidation after assignment:', meterValidation);
        } else {
          console.warn('[⚠️ AutoProcessor] Meter check returned failure:', meterResponse.data.message);
        }
      } catch (meterErr) {
        console.error('[❌ AutoProcessor] Meter check failed:', meterErr.message);
        // Don't fail the entire process for meter check failure
      }
    } else {
      console.log('[🔧 AutoProcessor] Skipping meter check - Include Utility not Yes or not LO contract');
    }

    // 2.11) Finally save compare + all validations in one shot
    const fullPayload = {
      contractNumber: contractId,
      compareResult,
      pdfGemini: geminiOut,
      webGemini: webGeminiRaw,
      validationResult,        // your document‐validation array
      webValidationResult: webValidation,  // your web‐validation array
      meterValidationResult: meterValidation  // meter validation array (if available)
    };
    
    console.log('[🔧 AutoProcessor] Final payload meterValidationResult:', meterValidation);
    console.log('[🔧 AutoProcessor] Final payload meterValidationResult type:', typeof meterValidation);
    
    await axios.post('http://localhost:5001/api/save-compare-result', fullPayload);
    console.log('[✅ Saved compare + all validations together]');

    return true

  } catch (err) {
    console.error('[❌ Error during processing]', err.message || err);
    // If anything in the above chain (extract→compare→validate→meter→web_validate) failed/timed out,
    // we close and return false so `processContractsInFolder` moves this PDF to “failed.”
    try { await browser.close(); } catch { }
    return false;
  }
}

async function checkIfFileExistsInFirebase(filename) {
  return false;
}



export { processOneContract, processContractsInFolder, delayedMove };