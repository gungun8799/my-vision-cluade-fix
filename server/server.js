// ===== server.js (Backend) =====
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import xlsx from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// at the top of your file
// either of these:
const fsPromises = fs.promises;      // define fsPromises
// …or just use fs.promises inline below

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
  
  // Handle unclosed think tags more aggressively
  if (cleaned.includes('<think>')) {
    console.log('[DEBUG stripThinkTags] Found unclosed think tag');
    
    // Try multiple approaches to find JSON after think tag
    const thinkPos = cleaned.indexOf('<think>');
    const textAfterThink = cleaned.substring(thinkPos);
    
    // Look for JSON patterns after the think tag
    const jsonArrayMatch = textAfterThink.match(/(\[[\s\S]*?\])/);
    const jsonObjectMatch = textAfterThink.match(/(\{[\s\S]*?\})/);
    
    if (jsonArrayMatch) {
      console.log('[DEBUG stripThinkTags] Found JSON array after think tag');
      cleaned = jsonArrayMatch[1];
    } else if (jsonObjectMatch) {
      console.log('[DEBUG stripThinkTags] Found JSON object after think tag');
      cleaned = jsonObjectMatch[1];
    } else {
      // Fallback: remove everything up to first { or [
      const jsonStart = textAfterThink.search(/[\[\{]/);
      if (jsonStart !== -1) {
        cleaned = textAfterThink.substring(jsonStart);
      }
    }
  }
  
  // Try to extract valid JSON using bracket/brace counting
  const extractedJson = extractValidJson(cleaned);
  if (extractedJson) {
    console.log('[DEBUG stripThinkTags] Successfully extracted JSON using bracket counting');
    cleaned = extractedJson;
  }
  
  // Final cleanup - remove any remaining < characters that might be artifacts
  cleaned = cleaned.replace(/^[^[{]*/, '');
  
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
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = req.query.path; // e.g. ?path=contracts
    if (!['contracts','processed'].includes(folder)) {
      return cb(new Error('Invalid upload path'), null);
    }
    const dest = path.join(__dirname, folder);
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    // preserve original filename–or customize as you like
    cb(null, file.originalname);
  }
});
const upload_2 = multer({ storage });



// Support __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ✅ Store Puppeteer sessions for different systems
const browserSessions = new Map();
// Env and Express setup
dotenv.config();
const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(cors());
app.use(express.json());
app.use(
  '/prompts',
  express.static(path.join(__dirname, 'prompts'))
);

// Add this route for checking file metadata and saving to Firebase
app.post('/api/process-pdf-folder', async (req, res) => {
  const folderPath = path.join(__dirname, 'contracts');  // Replace with your folder path
  const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.pdf'));

  const fileData = [];

  for (const file of files) {
    // ── IMMEDIATELY skip any filename that isn’t digits + "_" + (LO|LR) + digits + "_" + digits ──
    const baseName = file.replace(/\.pdf$/i, '');
    const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
    if (!validPattern.test(baseName)) {
      console.log(`[⏭️  Skipping invalid filename on server] ${file}`);
      continue;
    }
    
    const filePath = path.join(folderPath, file);
    
    // Get last modified timestamp of the file
    const stats = fs.statSync(filePath);
    const lastModifiedTime = stats.mtime;  // Last modified time

    // Assuming contract_number is the name of the file without extension
    const contractNumber = path.basename(file, '.pdf');

    // Save to Firebase (file_check collection)
    await db.collection('file_check').doc(contractNumber).set({
      contract_number: contractNumber,
      last_modified_time: lastModifiedTime,
      contract_status: 'pending',  // Initially set as 'pending'
    });

    fileData.push({
      contract_number: contractNumber,
      last_modified_time,
      contract_status: 'pending',
    });
  }

  console.log('[File Check] Processed file data:', fileData);

  res.json({ success: true, files: fileData });
});

app.post('/api/fetch-next-pdf-to-process', async (req, res) => {
  try {
    // Fetch files ordered by last_modified_time (ascending)
    const snapshot = await db.collection('file_check')
      .where('contract_status', '==', 'pending')  // Only get pending files
      .orderBy('last_modified_time', 'asc')  // Order by the last modified time
      .limit(1)  // Get the oldest file that hasn't been processed yet
      .get();

    if (snapshot.empty) {
      return res.status(200).json({ success: true, message: 'No files to process' });
    }

    const fileDoc = snapshot.docs[0];
    const fileData = fileDoc.data();

    // Update the status to 'in-progress'
    await fileDoc.ref.update({
      contract_status: 'in-progress',
    });

    console.log('[File Check] Next file to process:', fileData.contract_number);

    res.json({ success: true, fileData });
  } catch (err) {
    console.error('[File Check Error]', err);
    res.status(500).json({ success: false, message: 'Error fetching next file to process', error: err.message });
  }
});

app.post('/api/process-pdf', async (req, res) => {
  const { contractNumber, filePath } = req.body;

  try {
    // Open Puppeteer and navigate to the extraction page
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    page.setDefaultTimeout(0); // Disable all timeouts
    page.setDefaultNavigationTimeout(0); // Disable navigation timeouts

    // Navigate to the page containing the file extraction feature
    await page.goto('http://localhost:5001/extract-pdf'); // Adjust URL as needed

    // Simulate dragging the file into the file upload input area
    const inputElement = await page.$('input[type="file"]');
    await inputElement.uploadFile(filePath);  // Use the actual file path

    // Click the "Extract" button to start the extraction
    const extractButton = await page.$('button#extract');  // Adjust the selector as needed
    await extractButton.click();

    // Wait for the extraction to finish (you can set a timeout or wait for specific UI changes)
    await page.waitForSelector('#extraction-status', { visible: true });  // Adjust based on your UI

    console.log('[PDF Extract] Extraction finished for contract:', contractNumber);

    // Update the contract status in Firebase
    const fileDocRef = db.collection('file_check').doc(contractNumber);
    await fileDocRef.update({
      contract_status: 'completed',  // Set status to 'completed' after extraction
    });

    res.json({ success: true, message: `File processed: ${contractNumber}` });

    await browser.close();
  } catch (err) {
    console.error('[PDF Process Error]', err);
    res.status(500).json({ success: false, message: 'Error processing PDF', error: err.message });
  }
});


// Firebase Admin Init
const serviceAccount = JSON.parse(
  fs.readFileSync(path.join(__dirname, './loi-checker-firebase-adminsdk-fbsvc-e5de01d327.json'), 'utf8')
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

// Vision + Gemini
const visionClient = new ImageAnnotatorClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

app.post('/api/extract-text-only', upload.single('file'), async (req, res) => {
  console.log('Incoming request to /api/extract-text-only');

  const file = req.file;
  if (!file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const selectedPagesRaw = req.body.pages || 'all';
  const selectedPages = selectedPagesRaw.toLowerCase() === 'all'
    ? []
    : selectedPagesRaw.split(',').map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n));

  const ext = path.extname(file.originalname).toLowerCase();
  const localFilePath = path.join(__dirname, file.path);
  const gcsPath = `uploaded/${file.originalname}`;
  await bucket.upload(localFilePath, { destination: gcsPath });
  const gcsUri = `gs://${bucket.name}/${gcsPath}`;
  let combinedText = '';

  try {
    if (ext === '.pdf') {
      const outputPrefix = `vision-output/${path.parse(file.originalname).name}_${Date.now()}/`;

      const request = {
        inputConfig: {
          gcsSource: { uri: gcsUri },
          mimeType: 'application/pdf',
        },
        outputConfig: {
          gcsDestination: { uri: `gs://${bucket.name}/${outputPrefix}` },
          batchSize: 5,
        },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      };
      if (selectedPages.length > 0) request.pages = selectedPages;

      console.log('[🔁 OCR] Starting asyncBatchAnnotateFiles...');
      const [operation] = await visionClient.asyncBatchAnnotateFiles({ requests: [request] });
      await operation.promise();
      console.log('[✅ OCR] asyncBatchAnnotateFiles completed');

      const [outputFiles] = await bucket.getFiles({ prefix: outputPrefix });

      for (const f of outputFiles) {
        if (!f.name.endsWith('.json')) continue;
        const [jsonData] = await f.download();
        const parsed = JSON.parse(jsonData.toString());
        const responses = parsed.responses || [];
        responses.forEach((page, i) => {
          const text = page.fullTextAnnotation?.text || '';
          combinedText += `\n\nFile: ${file.originalname} — Page ${i + 1}\n${text}`;
        });
      }
    } else {
      const [result] = await visionClient.documentTextDetection(localFilePath);
      const text = result.fullTextAnnotation?.text || '';
      combinedText += `\n\nFile: ${file.originalname}\n${text}`;
    }

    console.log('[📤 OCR Text Ready]');
    res.json({ success: true, text: combinedText });
  } catch (err) {
    console.error('[❌ OCR Extraction Error]', err);
    res.status(500).json({ message: 'OCR extraction failed', error: err.message });
  } finally {
    fs.unlinkSync(localFilePath);
  }
});


// ===== SEQUENTIAL PROCESSING ENDPOINTS =====

// Initialize sequential processor
const sequentialProcessor = new SequentialProcessor();

// Sequential text extraction endpoint
app.post('/api/extract-text-sequential', upload.array('files'), async (req, res) => {
  console.log('Incoming request to /api/extract-text-sequential');
  const files = req.files;
  const contractType = req.body.contractType || 'permanent_fixed';
  const selectedPagesRaw = req.body.pages || 'all';
  const selectedPages = selectedPagesRaw.toLowerCase() === 'all'
    ? []
    : selectedPagesRaw.split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));

  if (!files || files.length === 0) {
    return res.status(400).json({ message: 'No files uploaded' });
  }

  let combinedText = '';

  // OCR processing (using the same GCS-based approach as working legacy endpoint)
  for (const file of files) {
    try {
      console.log(`[Sequential OCR] Processing file: ${file.originalname}, path: ${file.path}`);
      
      const ext = path.extname(file.originalname).toLowerCase();
      const localFilePath = path.join(__dirname, file.path);
      const gcsPath = `uploaded/${file.originalname}`;
      
      // Upload to GCS first (same as legacy endpoint)
      await bucket.upload(localFilePath, { destination: gcsPath });
      const gcsUri = `gs://${bucket.name}/${gcsPath}`;
      console.log(`[Sequential OCR] Uploaded to GCS: ${gcsUri}`);
      
      if (ext === '.pdf') {
        // Use the same batch processing approach as legacy endpoint for PDFs
        const outputPrefix = `vision-output/${path.parse(file.originalname).name}_${Date.now()}/`;
        
        const request = {
          inputConfig: {
            gcsSource: { uri: gcsUri },
            mimeType: 'application/pdf',
          },
          outputConfig: {
            gcsDestination: { uri: `gs://${bucket.name}/${outputPrefix}` },
            batchSize: 5,
          },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        };
        if (selectedPages.length > 0) request.pages = selectedPages;

        console.log('[Sequential OCR] Starting asyncBatchAnnotateFiles...');
        const [operation] = await visionClient.asyncBatchAnnotateFiles({ requests: [request] });
        await operation.promise();
        console.log('[Sequential OCR] asyncBatchAnnotateFiles completed');

        const [outputFiles] = await bucket.getFiles({ prefix: outputPrefix });
        for (const outputFile of outputFiles) {
          const [content] = await outputFile.download();
          const result = JSON.parse(content.toString());
          result.responses?.forEach((response, i) => {
            const page = response.fullTextAnnotation;
            if (page?.text) {
              const text = page.text;
              combinedText += `\n\nFile: ${file.originalname} — Page ${i + 1}\n${text}`;
            }
          });
        }
      } else {
        // For non-PDF files, use direct document text detection
        const [result] = await visionClient.documentTextDetection(localFilePath);
        const text = result.fullTextAnnotation?.text || '';
        combinedText += `\n\nFile: ${file.originalname}\n${text}`;
      }
      
      console.log(`[Sequential OCR] Text extracted from ${file.originalname}: ${combinedText.length - (combinedText.lastIndexOf(`File: ${file.originalname}`) || 0)} characters`);
      
    } catch (visionError) {
      console.error(`[❌ Sequential OCR Error] ${file.originalname}:`, visionError);
      return res.status(500).json({ message: 'OCR processing failed', error: visionError.message });
    }

    // Clean up local file
    fs.unlinkSync(file.path);
  }

  if (!combinedText.trim()) {
    console.error('[Sequential] No text extracted from uploaded files');
    return res.status(400).json({ message: 'No text extracted from uploaded files' });
  }

  console.log(`[Sequential] Total combined text length: ${combinedText.length}`);

  try {
    // Use sequential processing
    console.log(`[Sequential] Starting sequential processing for contract type: ${contractType}`);
    const extractedData = await sequentialProcessor.processSequential(combinedText, contractType, 'pdf');
    
    console.log(`[Sequential] Extracted ${Object.keys(extractedData).length} fields`);
    console.log(`[Sequential] Available fields: ${Object.keys(extractedData).slice(0, 5).join(', ')}...`);
    
    // Save to Firebase (using combined result as JSON string)
    const contractNumber = extractedData['Contract Number'] || extractedData['Contract number'] || 'unknown';
    const docId = typeof contractNumber === 'string' ? contractNumber.replace(/\//g, '_') : 'unknown';
    await db.collection('vision_results').doc(docId).set({
      timestamp: new Date(),
      extracted_text: combinedText,
      gemini_response: JSON.stringify(extractedData, null, 2),
      prompt_key: `sequential_${contractType}`,
      processing_method: 'sequential'
    });

    console.log(`[📤 Firebase] Sequential processing saved as ID: ${docId}`);
    res.json({ 
      success: true, 
      text: combinedText, 
      geminiOutput: JSON.stringify(extractedData, null, 2),
      extractedData: extractedData,
      processingMethod: 'sequential'
    });

  } catch (err) {
    console.error('[❌ Sequential Processing Error]', err);
    res.status(500).json({ message: 'Sequential processing failed', error: err.message });
  }
});

// Sequential validation endpoint
app.post('/api/validate-sequential', async (req, res) => {
  try {
    const { extractedData, contractType, contractNumber, sourceType = 'pdf' } = req.body;

    if (!extractedData || typeof extractedData !== 'object') {
      return res.status(400).json({ message: 'Invalid extractedData' });
    }

    console.log(`[Sequential Validation] Processing ${sourceType.toUpperCase()} validation for ${contractType || 'unknown'} contract: ${contractNumber || 'unknown'}`);
    const validationResults = await sequentialProcessor.processValidation(extractedData, contractType, contractNumber, sourceType);
    
    res.json({
      success: true,
      validation: validationResults,
      processingMethod: 'sequential'
    });

  } catch (err) {
    console.error('[❌ Sequential Validation Error]', err);
    res.status(500).json({ message: 'Sequential validation failed', error: err.message });
  }
});

// Sequential comparison endpoint
app.post('/api/compare-sequential', async (req, res) => {
  try {
    const { pdfData, webData, contractType, contractNumber } = req.body;

    if (!pdfData || !webData) {
      return res.status(400).json({ message: 'Missing pdfData or webData' });
    }

    console.log(`[Sequential Comparison] Processing ${contractType || 'unknown'} contract: ${contractNumber || 'unknown'}`);
    const comparisonResults = await sequentialProcessor.processComparison(pdfData, webData, contractType, contractNumber);
    
    res.json({
      success: true,
      comparison: comparisonResults,
      processingMethod: 'sequential'
    });

  } catch (err) {
    console.error('[❌ Sequential Comparison Error]', err);
    res.status(500).json({ message: 'Sequential comparison failed', error: err.message });
  }
});

// Sequential web scraping endpoint
app.post('/api/scrape-url-sequential', async (req, res) => {
  console.log('[Sequential] Incoming request to /api/scrape-url-sequential');
  const { systemType = 'simplicity', contractType = 'permanent_fixed', contractNumber } = req.body;

  if (!contractNumber) {
    return res.status(400).json({ success: false, message: 'Contract number required' });
  }

  let browser;
  let scrapedText = '';

  try {
    // Reuse existing browser session or create new one
    if (browserSessions.has(systemType)) {
      const session = browserSessions.get(systemType);
      
      // Validate that session is still connected and functional
      try {
        if (!session || !session.browser || typeof session.browser.pages !== 'function') {
          throw new Error('Browser session invalid or missing pages method');
        }
        await session.browser.pages(); // Test if browser is still valid
        browser = session.browser;
      } catch (browserError) {
        console.warn('[Sequential Web] Existing browser session invalid, creating new one:', browserError.message);
        try {
          if (session && session.browser) {
            await session.browser.close();
          }
        } catch (closeError) {
          // Ignore close errors
        }
        browserSessions.delete(systemType);
        browser = await puppeteer.launch({ headless: false });
        const page = await browser.newPage();
        page.setDefaultTimeout(0); // Disable all timeouts
        page.setDefaultNavigationTimeout(0); // Disable navigation timeouts
        browserSessions.set(systemType, { browser, page });
      }
    } else {
      browser = await puppeteer.launch({ headless: false });
      const page = await browser.newPage();
      page.setDefaultTimeout(0); // Disable all timeouts
      page.setDefaultNavigationTimeout(0); // Disable navigation timeouts
      browserSessions.set(systemType, { browser, page });
    }

    const pages = await browser.pages();
    let popup = pages.find(page => page.url().toLowerCase().includes('simplicity'));
    
    if (!popup) {
      console.log('[Sequential Web] No existing Simplicity page found, trying to use main session page');
      // Try to use the main session page instead of looking for popup
      const session = browserSessions.get(systemType);
      if (session && session.page) {
        popup = session.page;
        console.log('[Sequential Web] Using main session page');
      } else {
        console.log('[Sequential Web] No valid page found, please login first');
        return res.status(400).json({ 
          success: false, 
          message: 'No active Simplicity session found. Please login first via /api/scrape-login' 
        });
      }
    }

    // Navigate and scrape using the correct domain
    const searchUrl = `https://mall-management.lotuss.com/Simplicity/module/lease/offer/view_lease_offer_detail.php?search_data=${contractNumber}`;
    console.log('[Sequential Web] Navigating to:', searchUrl);
    
    await popup.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 0 });
    
    scrapedText = await popup.evaluate(() => document.body.innerText);
    console.log('[Sequential Web] Scraped content length:', scrapedText.length);
    console.log('[Sequential Web] Scraped content preview:', scrapedText.substring(0, 500));
    
    // Check for 404 errors or other error pages
    if (scrapedText.includes('HTTP Error 404') || scrapedText.includes('encountered an error')) {
      console.error('[Sequential Web] Error page detected - 404 or application error');
      console.log('[Sequential Web] Full error content:', scrapedText);
      
      // Try alternative approach: navigate through the menu system
      console.log('[Sequential Web] Trying alternative navigation through menu system...');
      
      try {
        // Go back to main Simplicity page
        await popup.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });
        
        // Navigate through menu: Lease > Lease Renewal (for LR contracts) or Lease Offer (for LO contracts)
        const isLeaseOffer = contractNumber.includes('LO');
        const submenuText = isLeaseOffer ? 'Lease Offer' : 'Lease Renewal';
        
        console.log(`[Sequential Web] Navigating to Lease > ${submenuText}...`);
        
        // Click on Lease menu
        await popup.waitForSelector('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a', { timeout: 10000 });
        await popup.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
        await popup.mouse.click(5, 5); // Click away to open submenu
        
        // Click on appropriate submenu
        const selector = isLeaseOffer
          ? '#menu_MenuLiteralDiv > ul > li:nth-child(10) > ul > li:nth-child(2) > a'
          : '#menu_MenuLiteralDiv > ul > li:nth-child(10) > ul > li:nth-child(1) > a';
        
        await popup.waitForSelector(selector, { timeout: 10000 });
        await popup.click(selector);
        
        // Wait for new page/popup to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Get the newly opened page (should be the last one)
        const pages = await popup.browser().pages();
        const latestPage = pages[pages.length - 1];
        
        // Navigate to the search URL in the new page
        await latestPage.goto(searchUrl, { waitUntil: 'networkidle2' });
        scrapedText = await latestPage.evaluate(() => document.body.innerText);
        
        console.log('[Sequential Web] Alternative navigation result - Content length:', scrapedText.length);
        
        // Close the extra page
        if (latestPage !== popup) {
          await latestPage.close();
        }
        
      } catch (navError) {
        console.error('[Sequential Web] Alternative navigation also failed:', navError.message);
        // Keep the original 404 content for processing
      }
    }
    
    // If scraped content is too short, it might indicate page load issues
    if (scrapedText.length < 500) {
      console.warn('[Sequential Web] Very short content detected - page might not have loaded properly');
      console.log('[Sequential Web] Full scraped content:', scrapedText);
    }

    // Use single extraction call for web data (not sequential steps)
    console.log('[Sequential Web] Processing web data with single extraction call');
    
    // Create a simplified extraction prompt for web data
    const extractionPrompt = `Extract all contract information from the following web content and return it as a valid JSON object.
    
    Focus on extracting these key fields:
    - Building Name, Building ID
    - Contract Number
    - Brand Name, Property Type
    - Customer Name, Customer Address
    - Tenant Type, Space Design Type
    - Unit ID, Unit Floor, Unit Area
    - Lease Start Date, Lease End Date
    - Billing Frequency, Payment Term
    - Net Rent (p.m.), Service Charge
    - Deposit Amount, Deposit Type
    - Include Utility (Yes/No)
    - Any other relevant contract fields
    
    Return ONLY a JSON object with the extracted fields. Use null for missing values.`;
    
    const finalPrompt = `${extractionPrompt}\n\nWeb Content:\n${scrapedText}`;
    
    // Use Lotus LLM for web data extraction
    const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
    const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';
    
    let extractedData;
    
    // If content contains 404 error or is too short, skip LLM processing to avoid socket hang up
    if (scrapedText.includes('HTTP Error 404') || scrapedText.includes('encountered an error') || scrapedText.length < 100) {
      console.warn('[Sequential Web] Error page or content too short for meaningful extraction - skipping LLM call');
      if (scrapedText.includes('HTTP Error 404')) {
        console.warn('[Sequential Web] 404 Error detected - URL may be incorrect or requires proper navigation');
      }
      extractedData = {};
    } else {
      // Add 5-second delay before LLM call to prevent too-quick API calls
      console.log('[Sequential Web] Waiting 5 seconds before calling Lotus LLM to prevent socket hang up...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Try LLM extraction with retry logic
      const maxRetries = 2;
      let success = false;
      
      for (let attempt = 1; attempt <= maxRetries && !success; attempt++) {
        try {
          console.log(`[Sequential Web] Calling Lotus LLM for web data extraction... (attempt ${attempt}/${maxRetries})`);
          
          const response = await axios.post(LOTUS_LLM_URL, {
            model: 'default',
            messages: [
              {
                role: 'system',
                content: 'You are a contract data extraction assistant. Extract data from the provided web content and return it as a valid JSON object only.'
              },
              {
                role: 'user',
                content: finalPrompt
              }
            ],
            temperature: 0.1,
            max_tokens: 1000, // Further reduced to avoid timeouts
            extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
          }, {
            headers: {
              'Authorization': `Bearer ${LOTUS_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000 // Reduced to 30 seconds
          });
          
          console.log('[Sequential Web] Lotus LLM call successful');
          const messageContent = response.data.choices[0].message.content;
          const reasoningContent = response.data.choices[0].message.reasoning_content;
          const webResponse = (messageContent || reasoningContent).trim();
          
          // Clean and parse the response
          const cleaned = sequentialProcessor.cleanGeminiJson(webResponse);
          extractedData = JSON.parse(cleaned);
          console.log('[Sequential Web] Successfully extracted', Object.keys(extractedData).length, 'fields from web data');
          success = true;
          
        } catch (webExtractionError) {
          console.error(`[Sequential Web] Web data extraction attempt ${attempt} failed:`, webExtractionError.message);
          
          if (webExtractionError.message.includes('socket hang up') || webExtractionError.code === 'ECONNRESET') {
            console.error('[Sequential Web] Socket hang up/connection reset detected');
          }
          
          if (attempt === maxRetries) {
            console.error('[Sequential Web] All extraction attempts failed - using empty data');
            extractedData = {};
          } else {
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
    }
    
    // ─── METER CHECK for Sequential Processing ─────────────────
    let utilityRaw = null;
    let meterValidation = null;

    // Debug the Include Utility field
    console.log('[Sequential Utility Debug] extractedData["Include Utility"]:', extractedData['Include Utility']);
    console.log('[Sequential Utility Debug] contractNumber:', contractNumber);
    console.log('[Sequential Utility Debug] contractNumber.includes("LO"):', contractNumber.includes('LO'));
    
    // Check for variations in utility field name and value
    const utilityValue = extractedData['Include Utility'] || extractedData['Utility'] || extractedData['Include utility'];
    const isUtilityYes = utilityValue && (utilityValue.toLowerCase() === 'yes' || utilityValue.toLowerCase().includes('yes'));
    
    console.log('[Sequential Utility Debug] utilityValue (normalized):', utilityValue);
    console.log('[Sequential Utility Debug] isUtilityYes:', isUtilityYes);
    
    if (isUtilityYes && contractNumber.includes('LO')) {
      console.log('[Sequential Utility] Include Utility=Yes & LO… → scraping Meter…');

      try {
        // Navigate to meter page
        await popup.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        console.log('[Sequential Utility] scrolled down');
        await new Promise(r => setTimeout(r, 2000));

        // Click Utilities top-menu
        const utilSel = '#menu_MenuLiteralDiv > ul > li:nth-child(22) > a > div.cssmenu-item-label';
        console.log('[Sequential Utility] clicking Utilities top-menu');
        await popup.waitForSelector(utilSel, { visible: true, timeout: 20000 });
        await popup.click(utilSel);

        // Hover to expand submenu
        console.log('[Sequential Utility] hovering Utilities submenu');
        await popup.evaluate(() => {
          const li = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(22)');
          li?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        await new Promise(r => setTimeout(r, 10000));

        // Click "Meter" submenu
        console.log('[Sequential Utility] clicking Meter submenu');
        const clickedMeter = await popup.evaluate(() => {
          const menu = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(25) ul');
          if (!menu) return false;
          const a = Array.from(menu.querySelectorAll('a'))
            .find(x => x.textContent.trim() === 'Meter');
          if (a) { a.click(); return true; }
          return false;
        });
        if (!clickedMeter) throw new Error('Could not click Meter submenu');
        console.log('[Sequential Utility] Meter submenu clicked');

        // Wait & switch to bottom iframe
        await new Promise(r => setTimeout(r, 10000));
        const frameHandle = await popup.waitForSelector('iframe[name="frameBottom"]', { timeout: 20000 });
        const frame = await frameHandle.contentFrame();
       
        await new Promise(r => setTimeout(r, 10000));

        // Combined Unit ID + Building ID search
        console.log('[Sequential Utility] preparing combined Unit ID + Building ID search');

        // Wait for the main search box
        await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 20000 });

        // Get Building ID from extracted data 
        const buildingId = extractedData['Building ID'] || '';
        console.log('[Sequential Utility] fetched Building ID:', buildingId);

        // Build the combined search string
        const unitId = extractedData['Unit ID'] || '';
        const combinedSearch = buildingId ? `${unitId} ${buildingId}` : unitId;

        console.log('[Sequential Utility] entering combined search:', combinedSearch);

        // Clear & type the combined string
        await frame.click('#panel_SimpleSearch_c1', { clickCount: 3 });
        await frame.type('#panel_SimpleSearch_c1', combinedSearch, { delay: 50 });

        // Click the initial Search button
        console.log('[Sequential Utility] clicking Search');
        await frame.evaluate(() => {
          const btn = document.querySelector('a#panel_buttonSearch_bt');
          btn?.click();
        });
        await new Promise(r => setTimeout(r, 15000));

        // Scrape meter page content
        utilityRaw = await frame.evaluate(() => document.body.innerText);
        console.log('[Sequentsial Utility] scraped raw after combined search:', utilityRaw);

        // Run meter validation using Lotus LLM
        const meterPromptPath = path.join(__dirname, 'prompts', 'meter_check.txt');
        if (fs.existsSync(meterPromptPath)) {
          const meterTemplate = fs.readFileSync(meterPromptPath, 'utf8');
          const meterPrompt = `${meterTemplate}\n\nMeter page content:\n${utilityRaw}`;
          console.log('[Sequential Meter Validation] sending to Lotus LLM');
          
          // Use Lotus LLM API for meter validation
          const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
          const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';
          
          const response = await axios.post(LOTUS_LLM_URL, {
            model: 'default',
            messages: [
              {
                role: 'user',
                content: meterPrompt
              }
            ],
            temperature: 0.1,
            max_tokens: 2000,
            extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LOTUS_API_KEY}`
            },
            timeout: 0 // No timeout - wait indefinitely
          });

          // Handle new API response format where content might be in reasoning_content
          const messageContent = response.data.choices[0].message.content;
          const reasoningContent = response.data.choices[0].message.reasoning_content;
          const meterResponse = (messageContent || reasoningContent).trim();
          console.log('[Sequential Meter Validation] Lotus LLM response:', meterResponse);

          try {
            meterValidation = JSON.parse(meterResponse);
            console.log('[Sequential Meter Validation] parsed successfully');
          } catch (parseErr) {
            console.error('[Sequential Meter Validation] parse error:', parseErr.message);
            meterValidation = [{ field: 'Meter Check', value: 'Error', valid: false, reason: 'Failed to parse meter validation response' }];
          }
        }

      } catch (meterErr) {
        console.error('[Sequential Utility] Error during meter scraping:', meterErr.message);
        meterValidation = [{ field: 'Meter Check', value: 'Error', valid: false, reason: `Meter scraping failed: ${meterErr.message}` }];
      }
    } else {
      console.log('[Sequential Utility] Skipping meter check - Include Utility not Yes or not LO contract');
    }
    
    // Save to Firebase (including meter validation if available)
    const contractId = contractNumber.replace(/\//g, '_');
    const saveData = {
      timestamp: new Date(),
      contract_number: contractId,
      web_extracted: scrapedText,
      gemini_output: JSON.stringify(extractedData, null, 2),
      processing_method: 'sequential',
      popup_url: popup.url()
    };
    
    if (meterValidation) {
      saveData.meter_validation = JSON.stringify(meterValidation, null, 2);
      saveData.utility_raw = utilityRaw;
    }
    
    await db.collection('web_scrape_results').doc(contractId).set(saveData, { merge: true });

    console.log('[Sequential Web] Processing complete');
    const responseData = {
      success: true,
      raw: scrapedText,
      geminiOutput: JSON.stringify(extractedData, null, 2),
      extractedData: extractedData,
      processingMethod: 'sequential',
      popupUrl: popup.url()
    };
    
    if (meterValidation) {
      responseData.meterValidation = meterValidation;
      responseData.utilityRaw = utilityRaw;
    }
    
    res.json(responseData);

  } catch (err) {
    console.error('[Sequential Web] Error:', err);
    console.error('[❌ Legacy endpoints have been removed - sequential web scraping must work]');
    return res.status(500).json({
      success: false,
      message: 'Sequential web scraping failed - legacy fallback disabled',
      error: err.message
    });
  }
});

// --- LOGIN endpoint ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    // Query Firestore collection 'user_login' where field 'email' == submitted email
    const snapshot = await db
      .collection('user_login')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // No user found with that email
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userDoc = snapshot.docs[0];
    const data = userDoc.data();

    // Simple plaintext comparison (since your example stores password="123456")
    if (data.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Successful login → return email & role
    return res.json({
      email: data.email,
      role: data.role,
    });
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ===== Excel Sheet Upload - Get Sheet Names =====
app.post('/api/get-sheet-names', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'No file uploaded' });

    const filePath = path.join(__dirname, file.path);
    const workbook = xlsx.readFile(filePath);
    const sheetNames = workbook.SheetNames;
    const tempFileName = `${uuidv4()}_${file.originalname}`;
    const tempDest = path.join(__dirname, 'uploads', tempFileName);

    fs.renameSync(filePath, tempDest);
    res.json({ sheetNames, tempFileName });
  } catch (err) {
    console.error('Error getting sheet names:', err);
    res.status(500).json({ message: 'Failed to get sheet names', error: err.message });
  }
});

// ===== Excel Sheet Processor =====
app.post('/api/process-sheet', async (req, res) => {
  try {
    const { fileName, sheetName, promptKey = 'LOI_permanent_fixed_fields' } = req.body;
    const filePath = path.join(__dirname, 'uploads', fileName);

    const promptFilePath = path.join(__dirname, 'prompts', `${promptKey}.txt`);
    if (!fs.existsSync(promptFilePath)) {
      return res.status(400).json({ message: `Prompt template '${promptKey}' not found.` });
    }
    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');

    const workbook = xlsx.readFile(filePath);
    if (!workbook.Sheets[sheetName]) {
      return res.status(400).json({ message: `Sheet "${sheetName}" not found` });
    }

    const jsonData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const jsonString = JSON.stringify(jsonData, null, 2);

    const finalPrompt = `${promptTemplate}\n\nData:\n${jsonString}`;
    const geminiRes = await model.generateContent({
  contents: [{ parts: [{ text: finalPrompt }] }],
  generationConfig: {
    temperature: 0.1,        // 🔽 Lower = less hallucination
    topK: 1,
    topP: 0.8,
    maxOutputTokens: 5000
  }
});
    const geminiText = stripThinkTags(await geminiRes.response.text());

    // Attempt to extract Contract Number
    let contractId = 'unknown_excel_id';
    try {
      const match = geminiText.match(/"Contract Number"\s*:\s*"([^"]+)"/);
      if (match) contractId = match[1].replace(/\//g, '_');
      console.log('[📄 Excel Contract ID]', contractId);
    } catch (err) {
      console.warn('[⚠️ Could not extract contract number from Excel Gemini]', err.message);
    }

    await db.collection('excel_results').doc(contractId).set({
      timestamp: new Date(),
      raw_data: jsonString,
      gemini_response: geminiText,
      prompt_key: promptKey,
    });

    fs.unlinkSync(filePath);

    res.json({ success: true, table: jsonData, geminiOutput: geminiText });
  } catch (err) {
    console.error('Error in /api/process-sheet:', err);
    res.status(500).json({ message: 'Error processing sheet', error: err.message });
  }
});

// ===== Web Scraping =====
// ===== Web Scraping (Simplicity Internal Navigation) =====
// ... (existing imports & setup code remain unchanged)

// LEGACY ENDPOINT REMOVED - Use /api/scrape-url-sequential instead
/*
app.post('/api/scrape-url', async (req, res) => {
  console.log('[Simplicity] Incoming request to /api/scrape-url');
  console.log('[Request Body]', req.body);

  try {
    const { systemType = 'simplicity', contractType = 'permanent_fixed', contractNumber } = req.body;

    if (!contractNumber) {
      console.error('[❌ No contract number provided]');
      return res.status(400).json({ message: 'Contract number is required' });
    }

    if (!browserSessions.has(systemType)) {
      console.error('[❌ Not logged in for system type]', systemType);
      return res.status(401).json({ message: 'Not logged in for Simplicity' });
    }

    const session = browserSessions.get(systemType);
    if (!session || !session.browser || !session.page) {
      console.error('[❌ Invalid browser session]');
      return res.status(500).json({ message: 'Invalid browser session. Please login again.' });
    }
    
    const { browser, page } = session;
    const isLeaseOffer = contractNumber.includes('LO');
    const submenuText = isLeaseOffer ? 'Lease Offer' : 'Lease Renewal';

    console.log(`[Simplicity] Navigating Lease > ${submenuText}...`);
    await page.waitForSelector('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a', { timeout: 10000 });
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    await page.mouse.click(5, 5);
    await new Promise(resolve => setTimeout(resolve, 500));

    await page.evaluate(() => {
      const leaseMenu = [...document.querySelectorAll('a')].find(el => el.textContent.trim() === 'Lease');
      if (leaseMenu) leaseMenu.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const submenuClicked = await page.evaluate((submenuText) => {
      const links = [...document.querySelectorAll('a')];
      const target = links.find(el => el.textContent.trim() === submenuText);
      if (target) {
        target.click();
        return true;
      }
      return false;
    }, submenuText);

    if (!submenuClicked) {
      console.error(`❌ Could not click ${submenuText}`);
      throw new Error(`❌ Could not click ${submenuText}`);
    }

    console.log(`✅ ${submenuText} clicked`);
    await new Promise(resolve => setTimeout(resolve, 10000));

    let scrapedText = '';

    if (contractNumber) {
      console.log('[Simplicity] Searching for contract number:', contractNumber);
      await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 70000 });
      const iframeHandle = await page.$('iframe[name="frameBottom"]');
      const frame = await iframeHandle.contentFrame();
      if (!frame) {
        console.error('❌ Could not access iframe content');
        throw new Error('❌ Could not access iframe content');
      }

      await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 70000 });
      console.log('[Simplicity] Typing and submitting contract number...');
      await frame.evaluate((contract) => {
        const input = document.querySelector('#panel_SimpleSearch_c1');
        input.value = contract;
        input.focus();
      }, contractNumber);

      // <<< REPLACED CLICK TECHNIQUE >>>
      console.log('[Simplicity] Clicking search <a> button...');
      await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true, timeout: 10000 });
      await frame.evaluate(() => {
        const btn = document.querySelector('a#panel_buttonSearch_bt');
        if (btn) btn.click();
      });
      await new Promise(resolve => setTimeout(resolve, 15000));

      console.log('[Simplicity] Clicking view icon...');
      const viewButton = await frame.$('input[src*="view-black-16.png"]');
      if (!viewButton) {
        console.error('❌ View icon not found');
        throw new Error('❌ View icon not found');
      }
      await viewButton.click();

      const popupUrlMatch = contractNumber.includes('LO')
      ? 'leaseoffer/edit.aspx'
      : 'leaserenewal/edit.aspx';

      // Clean up leftover popups
      const oldPages = await browser.pages();
      for (const p of oldPages) {
        const url = p.url();
        if (url.includes('leaseoffer/edit.aspx') || url.includes('leaserenewal/edit.aspx')) {
          if (p !== page) await p.close();
        }
      }

      // Now wait for the new popup
      let popup;
      for (let i = 0; i < 15; i++) {
        console.log(`[Simplicity] Popup search attempt ${i + 1}/15, looking for URL containing: ${popupUrlMatch}`);
        const pages = await browser.pages();
        console.log(`[Simplicity] Current pages (${pages.length} total):`, pages.map(p => p.url()));
        popup = pages.find(p => p.url().includes(popupUrlMatch) && p !== page);
        if (popup) {
          console.log(`[Simplicity] ✅ Popup found: ${popup.url()}`);
          break;
        }
        console.log(`[Simplicity] ⏳ Popup not found yet, waiting 2 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    
    if (!popup) {
      console.error('❌ Popup window not found for:', popupUrlMatch);
      console.log('[Simplicity] 🔍 All current pages at timeout:');
      const allPages = await browser.pages();
      allPages.forEach((p, index) => {
        console.log(`  Page ${index + 1}: ${p.url()}`);
      });
      
      // Try to find any new page that appeared after the main page
      const possiblePopup = allPages.find(p => p !== page && !p.url().includes('apptop.aspx') && !p.url().includes('about:blank'));
      if (possiblePopup) {
        console.log(`[Simplicity] 🔍 Found possible popup with different URL: ${possiblePopup.url()}`);
        popup = possiblePopup;
      } else {
        throw new Error('❌ Popup window not found');
      }
    }




      console.log('[Simplicity] Bringing popup to front...');
      await popup.bringToFront();
      
      console.log('[Simplicity] Waiting for popup content to load...');
      await popup.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 0 });

      console.log('[Simplicity] Waiting for popup navigation to complete...');
      try {
        await Promise.race([
          popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }),
          new Promise(resolve => setTimeout(resolve, 10000))
        ]);
        console.log('[Simplicity] ✅ Navigation complete or timeout reached');
      } catch (err) {
        console.warn('[⚠️ popup.waitForNavigation] Error or already loaded:', err.message);
      }

      // build your TYPE value however you need, then…
     // const encodedType = encodeURIComponent(typeValue);  // ← whatever logic you use to pick/type‐encode your TYPE
      const popupUrl = popup.url();
      console.log('[Simplicity] Final popup URL with params:', popupUrl);
      
      console.log('[Simplicity] Expanding all collapsible sections...');
      const collapsibleIds = [
        '#panelMonthlyCharge_label',
        '#panelOtherMonthlyCharge_label',
        '#panelGTO_label',
        '#LeaseMeterTypessArea_label',
        '#panelSecurityDeposit_label',
        '#panelOneTimeCharge_label'
      ];

      console.log('[Simplicity] Waiting 10 seconds for page to fully load...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      console.log('[Simplicity] Starting to expand collapsible sections...');
      for (let i = 0; i < collapsibleIds.length; i++) {
        const selector = collapsibleIds[i];
        console.log(`[Simplicity] Processing collapsible ${i + 1}/${collapsibleIds.length}: ${selector}`);
        try {
          const element = await popup.$(selector);
          if (!element) {
            console.log(`[Simplicity] ⚠️ Element not found: ${selector}`);
            continue;
          }
          
          const isCollapsed = await popup.$eval(selector, el => el.classList.contains('collapsible-panel-collapsed'));
          console.log(`[Simplicity] ${selector} collapsed status: ${isCollapsed}`);
          
          if (isCollapsed) {
            console.log(`[Simplicity] Clicking to expand: ${selector}`);
            await popup.click(selector);
            console.log(`[Simplicity] ✅ Expanded: ${selector}`);
            console.log(`[Simplicity] Waiting 7 seconds for expansion to complete...`);
            await new Promise(resolve => setTimeout(resolve, 7000));
          } else {
            console.log(`[Simplicity] Already expanded: ${selector}`);
          }
        } catch (err) {
          console.warn(`[Simplicity] ⚠️ Could not expand ${selector}:`, err.message);
        }
      }
      
      console.log('[Simplicity] Finished expanding all collapsible sections');

      scrapedText = await popup.evaluate(() => document.body.innerText);
      console.log('[Simplicity] Scraped content:', scrapedText);

      // Use PromptManager to get extraction prompt
      const promptManager = new PromptManager();
      let promptTemplate;
      try {
        promptTemplate = promptManager.createLegacyExtractionPrompt(contractType);
        console.log(`[✅ Loaded modular extraction prompt for ${contractType}]`);
      } catch (err) {
        console.error(`[❌ Failed to load extraction prompt for ${contractType}]`, err);
        return res.status(400).json({ message: `Failed to load extraction prompt for ${contractType}`, error: err.message });
      }

      const finalPrompt = `${promptTemplate}\n\nContent:\n${scrapedText}`;

      console.log('[Simplicity] Sending content to Lotus LLM...');
      
      // Use Lotus LLM API instead of Gemini for web scraping
      const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
      const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';
      
      let geminiText;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`[🔄 Lotus LLM web scraping attempt ${attempt}/${maxRetries}]`);
          
          const response = await axios.post(LOTUS_LLM_URL, {
            model: 'default',
            messages: [
              {
                role: 'system',
                content: 'You are a contract data extraction assistant. Extract data from the provided content and return it as a valid JSON object only.'
              },
              {
                role: 'user',
                content: finalPrompt
              }
            ],
            temperature: 0.1,
            max_tokens: 5000,
            extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
          }, {
            headers: {
              'Authorization': `Bearer ${LOTUS_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 0 // No timeout - wait indefinitely
          });
          
          // Handle new API response format where content might be in reasoning_content
          const messageContent = response.data.choices[0].message.content;
          const reasoningContent = response.data.choices[0].message.reasoning_content;
          geminiText = stripThinkTags(messageContent || reasoningContent);
          console.log('[✅ Lotus LLM web scraping successful]');
          break;
        } catch (fetchError) {
          console.warn(`[⚠️ Lotus LLM web scraping attempt ${attempt}/${maxRetries} failed]`, fetchError.message);
          
          if (attempt === maxRetries) {
            console.error('[❌ All Lotus LLM web scraping attempts failed]');
            throw new Error(`Lotus LLM API failed after ${maxRetries} attempts: ${fetchError.message}`);
          }
          
          // Add delay between retries
          const waitTime = 2000 * attempt; // 2s, 4s, 6s
          console.log(`[⏳ Web scraping waiting ${waitTime}ms before retry...]`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      let contractId = contractNumber || 'unknown_scrape_id';
      let leaseType = '';
      let workflowStatus = '';
      let tenantType = '';

      try {
        const match = geminiText.match(/"Contract Number"\s*:\s*"([^"]+)"/);
        if (match) contractId = match[1].replace(/\//g, '_');

        const leaseTypeMatch = geminiText.match(/"Lease Type"\s*:\s*"([^"]+)"/);
        if (leaseTypeMatch) leaseType = leaseTypeMatch[1];

        const workflowStatusMatch = geminiText.match(/"Workflow status"\s*:\s*"([^"]+)"/);
        if (workflowStatusMatch) workflowStatus = workflowStatusMatch[1];

        const tenantTypeMatch = geminiText.match(/"Tenant Type"\s*:\s*"([^"]+)"/);
        if (tenantTypeMatch) tenantType = tenantTypeMatch[1];

        console.log('[📄 Scrape Contract ID]', contractId, '[Lease Type]', leaseType, '[Workflow Status]', workflowStatus);
      } catch (err) {
        console.warn('[⚠️ Could not extract fields from Scrape Gemini]', err.message);
      }

      await db.collection('compare_result').doc(contractId).set({
        timestamp: new Date(),
        contract_number: contractId,
        web_extracted: scrapedText,
        gemini_output: geminiText, // ✅ ADD THIS
        lease_type: leaseType,
        workflow_status: workflowStatus,
        tenant_type: tenantType,
      }, { merge: true });

      console.log(`[🔥 Firebase] Document saved to 'compare_result': ${contractId}`);

      res.json({ 
        success: true,
        raw: scrapedText,
        geminiOutput: geminiText,
        popupUrl
      });
    }
  } catch (err) {
    console.error('[Simplicity scrape-url error]', err);
    res.status(500).json({ message: 'Error during Simplicity navigation', error: err.message });
  }
});
*/



app.post('/api/open-popup-tab', async (req, res) => {
  const { systemType = 'simplicity', contractNumber } = req.body;
  console.log('[🗭 Request] /api/open-popup-tab', { systemType, contractNumber });

  if (!contractNumber) return res.status(400).json({ message: 'Contract number required.' });

  try {
    let browser, page;

    // --- LOGIN STEP (two-step) ---
    if (!browserSessions.has(systemType)) {
      console.log('[🔑 Not logged in — triggering two-step login]');

      const puppeteer = await import('puppeteer');
      browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-fullscreen']
      });
      page = await browser.newPage();
      page.setDefaultTimeout(0); // Disable all timeouts
      page.setDefaultNavigationTimeout(0); // Disable navigation timeouts

      // 1) Load landing
      console.log('[Login] Navigating to apptop.aspx');
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', {
        waitUntil: 'networkidle2',
      });

      // 2) Click “Click to go to the login page”
      console.log('[Login] Waiting for Go-to-login button');
      await page.waitForSelector('#lblToLoginPage', { timeout: 20000 });
      console.log('[Login] Clicking Go-to-login');
      await page.click('#lblToLoginPage');
      await new Promise(r => setTimeout(r, 5000));

      // 3) Username + Continue
      console.log('[Login] Waiting for username field');
      await page.waitForSelector('input#username', { timeout: 20000 });
      console.log('[Login] Typing username');
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });
      const cont1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      console.log('[Login] Waiting for Continue #1');
      await page.waitForSelector(cont1, { timeout: 20000 });
      console.log('[Login] Clicking Continue #1');
      await page.click(cont1);
      await new Promise(r => setTimeout(r, 5000));

      // 4) Password + Continue
      console.log('[Login] Waiting for password field');
      await page.waitForSelector('input#password', { timeout: 20000 });
      console.log('[Login] Typing password');
      await page.type('input#password', 'Gofresh@0725-19', { delay: 50 });
      const cont2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      console.log('[Login] Waiting for Continue #2');
      await page.waitForSelector(cont2, { timeout: 20000 });
      console.log('[Login] Clicking Continue #2');
      await page.click(cont2);

      // 5) Wait for post-login
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));

      // 6) Verify
      const html = await page.content();
      if (html.includes('Invalid login')) {
        console.error('[Login] Invalid credentials');
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      }

      browserSessions.set(systemType, { browser, page });
      console.log('[✅ Login successful]');
    } else {
      ({ browser, page } = browserSessions.get(systemType));
    }

    // --- NAVIGATION & POPUP (unchanged) ---
    console.log('[📂 Navigating to Lease tab]');
    await page.waitForSelector('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a', { timeout: 10000 });
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Lease');
      if (el) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const menuToClick = contractNumber.includes('LR') ? 'Lease Renewal' : 'Lease Offer';
    const clicked = await page.evaluate((menuText) => {
      const target = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === menuText);
      if (target) { target.click(); return true; }
      return false;
    }, menuToClick);

    if (!clicked) throw new Error(`❌ Could not click ${menuToClick}`);
    console.log(`[📎 Clicked submenu: ${menuToClick}]`);
    await new Promise(r => setTimeout(r, menuToClick === 'Lease Renewal' ? 8000 : 5000));

    const iframeHandle = await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 70000 });
    const frame = await iframeHandle.contentFrame();
    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true });
    await frame.evaluate((cn) => {
      const input = document.querySelector('#panel_SimpleSearch_c1');
      input.value = cn; input.focus();
    }, contractNumber);

    await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true });
    await frame.evaluate(() => document.querySelector('a#panel_buttonSearch_bt')?.click());
    await new Promise(r => setTimeout(r, 10000));

    const viewBtn = await frame.$('input[src*="view-black-16.png"]');
    if (!viewBtn) throw new Error('❌ View icon not found');
    await viewBtn.click();

    console.log('[📝 Waiting for popup tab...]');
    let popup;
    for (let i = 0; i < 10; i++) {
      const pages = await browser.pages();
      popup = pages.find(p => p.url().includes('leaseoffer/edit.aspx') && p !== page);
      if (popup) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (popup) {
      await popup.bringToFront();
      console.log('[✅ Popup tab opened]');
    } else {
      console.warn('[⚠️ Popup tab not detected]');
    }

    return res.json({ success: true, message: `Popup triggered for ${menuToClick}.` });

  } catch (err) {
    console.error('[❌ /api/open-popup-tab error]', err);
    return res.status(500).json({ message: err.message });
  }
});


// end of scrape logic
app.post('/api/scrape-login', async (req, res) => {
  const { systemType, username, password } = req.body;

  // No‐op for “others”
  if (!systemType || systemType === 'others') {
    return res.status(200).json({ success: true, message: 'No login required for Others.' });
  }

  try {
    let browser, page;

    // 1) Reuse session if we already have one
    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
    } else {
      // 2) Launch fresh browser + page
      browser = await puppeteer.launch({ headless: false });
      page = await browser.newPage();
      page.setDefaultTimeout(0); // Disable all timeouts
      page.setDefaultNavigationTimeout(0); // Disable navigation timeouts

      // 3) Go to the Simplicity landing page
      await page.goto(
        'https://mall-management.lotuss.com/Simplicity/apptop.aspx',
        { waitUntil: 'networkidle2' }
      );

      // 4) Click “Click to go to the login page” + wait for it to load
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
      await Promise.all([
        page.click('#lblToLoginPage'),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);

      // 5) Enter username and Continue
      await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
      await page.type('input#username', username, { delay: 50 });

      const continueSel1 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
      await page.click(continueSel1);

      // 6) Enter password and Continue
      await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
      await page.type('input#password', password, { delay: 50 });

      const continueSel2 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      await page.waitForSelector(continueSel2, { visible: true, timeout: 20000 });
      await Promise.all([
        page.click(continueSel2),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
      ]);

      // small extra buffer
      await new Promise(r => setTimeout(r, 10000));

      // 7) Verify login succeeded
      const html = await page.content();
      if (html.includes('Invalid login')) {
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      // 8) Store for reuse
      browserSessions.set(systemType, { browser, page });
    }

    console.log(`[LOGIN] Simplicity login successful for ${username}`);
    return res.json({ success: true });

  } catch (err) {
    console.error('[SCRAPE-LOGIN Error]', err);
    return res.status(500).json({
      success: false,
      message: 'Login failed',
      error: err.message
    });
  }
});


// ===== Get Available Prompt Templates (.txt files) =====
app.get('/api/prompts', (req, res) => {
  const promptsDir = path.join(__dirname, 'prompts'); // assume ./prompts holds .txt files
  fs.readdir(promptsDir, (err, files) => {
    if (err) {
      console.error('Failed to read prompt directory:', err);
      return res.status(500).json({ message: 'Failed to read prompt templates' });
    }
    const promptKeys = files.filter(file => file.endsWith('.txt')).map(f => f.replace('.txt', ''));
    res.json({ promptKeys });
  });
});

// === Endpoint: Fetch latest gemini_response for selected sources ===
app.post('/api/fetch-latest-json', async (req, res) => {
  const { sources } = req.body;
  const collectionMap = {
    pdf: 'vision_results',
    web: 'scrape_results',  // Ensure that `scrape_results` is being used for the 'web' source
    excel: 'excel_results',
  };

  try {
    const results = {};

    for (const src of sources) {
      const collectionName = collectionMap[src];
      if (!collectionName) continue;

      const snapshot = await db
        .collection(collectionName)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0].data();
        console.log(`[Firebase doc for ${src}]`, doc);  // Log the full doc to check the structure

        // Check if gemini_response exists
        let geminiResponse = doc.gemini_response || '';  // Default to an empty string if missing
        if (!geminiResponse) {
          console.warn(`[Firebase] No gemini_response found for source: ${src}`);
        }

        // Clean and trim the response
        let cleaned = geminiResponse.trim();
        cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
        results[src] = cleaned;
        console.log(`[Firebase Cleaned] ${src}: ${cleaned}`);
      } else {
        console.warn(`[Firebase] No document found for source: ${src}`);
        results[src] = null;
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('Error fetching latest JSON:', err);
    res.status(500).json({ message: 'Failed to fetch JSON from Firebase', error: err.message });
  }
});

// ===== FALLBACK COMPARISON FIELDS FUNCTION =====
function getFallbackComparisonFields(category) {
  const fallbackData = {
    basic: [
      { field: "อยู่กองทรัสต์หรือไม่", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Building Name", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Brand Name", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Customer Name", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Customer Address", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Unit ID", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Space (NLA)", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Tenant Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Proposed lease commencement date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Proposed lease expiry date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Billing Frequency", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" }
    ],
    lease_terms: [
      { field: "Lease Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Monthly charge", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Contract Start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Contract End date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Charge Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Monthly Amount of rent", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Monthly Amount of service", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Contract Start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Contract End date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Charge Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Monthly Amount of rent", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Monthly Amount of service", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Contract Start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Contract End date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Charge Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Monthly Amount of rent", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Monthly Amount of service", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Total Rent Deposits", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Total Service Deposits", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" }
    ],
    lease_basic: [
      { field: "Lease Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Billing Frequency", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Monthly charge", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" }
    ],
    lease_years: [
      { field: "Year 1 : Contract Start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Contract End date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Charge Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Monthly Amount of rent", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 1 : Monthly Amount of service", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Contract Start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Contract End date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Charge Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Monthly Amount of rent", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 2 : Monthly Amount of service", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Contract Start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Contract End date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Charge Type", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Monthly Amount of rent", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Year 3 : Monthly Amount of service", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Total Rent Deposits", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Total Service Deposits", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" }
    ],
    service_charges: [
      { field: "Other service charge (in the renting space)", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Other service charge (in the renting space) Charge description", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Other service charge (in the renting space) start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Other service charge (in the renting space) end date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Other service charge (Common area)", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Other service charge (Common area) Charge description", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Other service charge (Common area) start date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Other service charge (Common area) end date", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" }
    ],
    tax_deposits: [
      { field: "Lease property tax", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Deposits Amount", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" }
    ],
    utilities: [
      { field: "Include Utility", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Utilities charge (water)", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Utilities charge (Electricity)", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" },
      { field: "Utilities charge (cooking gas)", pdf: "Processing timeout", web: "Processing timeout", match: false, reason: "Category timed out - unable to compare" }
    ]
  };
  
  return fallbackData[category] || [{ field: `${category}_fallback`, pdf: "Unknown category", web: "Unknown category", match: false, reason: "Unknown category processed" }];
}

// LEGACY ENDPOINT REMOVED - Use /api/compare-sequential instead
app.post('/api/gemini-compare', async (req, res) => {
  console.log('[👁️ HIT /api/gemini-compare]')
  const { formattedSources, promptKey = 'LOI_permanent_fixed_fields', contractNumber, contractType: requestContractType } = req.body;

  try {
    // 🔍 Use contractType from request body if provided, otherwise derive from promptKey
    const contractType = requestContractType || (promptKey.includes('service_express') ? 'service_express' : 'permanent_fixed');
    console.log(`[🔍 Contract type resolved] RequestType: ${requestContractType}, PromptKey: ${promptKey}, Final: ${contractType}`);
    
    // Use PromptManager to get comparison prompts
    const promptManager = new PromptManager();
    const comparisonCategories = ['basic', 'lease_basic', 'lease_years', 'service_charges', 'utilities', 'tax_deposits'];
    
    // Prepare sources string once
    const sourcesString = Object.entries(formattedSources)
      .map(([key, json]) => `${key.toUpperCase()}: ${JSON.stringify(json, null, 2)}`)
      .join('\n\n');
    
    // Use Lotus LLM API instead of Gemini for comparison
    const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
    const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';
    
    // Process each category separately to avoid overload
    const allResults = [];
    console.log('[🔄 Using chunked Lotus LLM comparison]');
    
    for (const category of comparisonCategories) {
      try {
        console.log(`[📊 Processing category: ${category}]`);
        const categoryPrompt = promptManager.createComparisonPrompt(category, contractType, contractNumber);
        const finalPrompt = `${categoryPrompt}\n\nSources:\n${sourcesString}`;
        
        // Log the prompt for basic category (where LR rule should apply)
        if (category === 'basic') {
          console.log(`[🔍 BASIC CATEGORY PROMPT PREVIEW]:`);
          console.log(`Contract Number in prompt: ${contractNumber}`);
          console.log(`Prompt preview (first 500 chars): ${finalPrompt.substring(0, 500)}...`);
          if (finalPrompt.includes('LR CONTRACT RULE')) {
            console.log(`[✅ LR CONTRACT RULE found in basic category prompt]`);
          } else {
            console.log(`[❌ LR CONTRACT RULE NOT found in basic category prompt]`);
          }
        }
        
        // Add delay between requests to avoid overload
        if (allResults.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay to reduce API load
        }
        
        const response = await axios.post(LOTUS_LLM_URL, {
          model: 'default',
          messages: [
            {
              role: 'system',
              content: 'You are a contract comparison assistant. Return ONLY a valid JSON array without any markdown formatting, code blocks, or additional text. Do not use ```json or ``` markers.'
            },
            {
              role: 'user',
              content: finalPrompt
            }
          ],
          temperature: 0.1,
          max_tokens: 4000, // Further increased for complete field lists
          extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
        }, {
          headers: {
            'Authorization': `Bearer ${LOTUS_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10800000 // 3 hours timeout (effectively infinite)
        });
        
        // Handle new API response format where content might be in reasoning_content
        const messageContent = response.data.choices[0].message.content;
        const reasoningContent = response.data.choices[0].message.reasoning_content;
        const categoryResult = messageContent || reasoningContent;
        console.log(`[✅ Category ${category} processed successfully]`);
        console.log(`[🔍 ${category} raw response length:`, categoryResult.length);
        console.log(`[🔍 ${category} response preview:`, categoryResult.substring(0, 500) + '...');
        
        // Strip think tags first, then clean the response
        const withoutThinkTags = stripThinkTags(categoryResult);
        let cleanedResult = withoutThinkTags.trim();
        console.log(`[🧹 ${category} after cleaning length:`, cleanedResult.length);
        
        // Remove markdown code blocks if present
        if (cleanedResult.includes('```json')) {
          cleanedResult = cleanedResult.replace(/```json\s*/gi, '').replace(/```/g, '');
        } else if (cleanedResult.includes('```')) {
          cleanedResult = cleanedResult.replace(/```\s*/g, '');
        }
        
        // Remove any stray backticks
        cleanedResult = cleanedResult.replace(/`/g, '').trim();
        
        // Additional cleanup for malformed JSON
        // Handle case where there might be duplicate JSON arrays or extra content
        if (cleanedResult.includes('][')) {
          console.log(`[🔧 ${category}] Found duplicate arrays, taking first valid array`);
          const firstArrayEnd = cleanedResult.indexOf('][');
          cleanedResult = cleanedResult.substring(0, firstArrayEnd + 1);
        }
        
        // Find the first complete JSON array if there's extra content after
        const firstBracket = cleanedResult.indexOf('[');
        if (firstBracket !== -1) {
          let bracketCount = 0;
          let endPos = firstBracket;
          
          for (let i = firstBracket; i < cleanedResult.length; i++) {
            if (cleanedResult[i] === '[') bracketCount++;
            else if (cleanedResult[i] === ']') bracketCount--;
            
            if (bracketCount === 0) {
              endPos = i + 1;
              break;
            }
          }
          
          if (endPos < cleanedResult.length) {
            console.log(`[🔧 ${category}] Trimming extra content after JSON array`);
            cleanedResult = cleanedResult.substring(firstBracket, endPos);
          }
        }
        
        // Parse and merge results
        try {
          const parsed = JSON.parse(cleanedResult);
          if (Array.isArray(parsed)) {
            console.log(`[✅ ${category} parsed successfully - ${parsed.length} fields]`);
            console.log(`[📊 ${category} fields:`, parsed.map(p => p.field).join(', '));
            allResults.push(...parsed);
          } else if (parsed && typeof parsed === 'object' && parsed.field) {
            // Handle single object response - wrap it in an array
            console.warn(`[⚠️ Category ${category} returned single object instead of array - wrapping it]`);
            console.log(`[✅ ${category} parsed successfully - 1 field (wrapped)]`);
            console.log(`[📊 ${category} fields:`, parsed.field);
            allResults.push(parsed);
          } else {
            console.warn(`[⚠️ Category ${category} did not return an array or valid object]`);
          }
        } catch (parseErr) {
          console.warn(`[⚠️ Failed to parse category ${category} results]`, parseErr.message);
          
          // Handle truncated JSON by finding last complete object
          if (parseErr.message.includes('Unexpected end of JSON input') || parseErr.message.includes('Unterminated')) {
            console.log(`[🩹 ${category}] Attempting to fix truncated JSON`);
            
            try {
              // Find the last complete object by looking for complete "}," or "}" patterns
              let truncatedResult = cleanedResult;
              
              // Find the last complete object ending
              let lastCompleteEnd = -1;
              let braceCount = 0;
              let inString = false;
              let escapeNext = false;
              
              for (let i = 0; i < truncatedResult.length; i++) {
                const char = truncatedResult[i];
                
                if (escapeNext) {
                  escapeNext = false;
                  continue;
                }
                
                if (char === '\\' && inString) {
                  escapeNext = true;
                  continue;
                }
                
                if (char === '"' && !escapeNext) {
                  inString = !inString;
                  continue;
                }
                
                if (!inString) {
                  if (char === '{') braceCount++;
                  else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                      lastCompleteEnd = i;
                    }
                  }
                }
              }
              
              if (lastCompleteEnd > 0) {
                // Trim to last complete object and close array
                const fixedJson = truncatedResult.substring(0, lastCompleteEnd + 1) + '\n]';
                console.log(`[🔧 ${category}] Fixed JSON length: ${fixedJson.length}`);
                
                const fixedParsed = JSON.parse(fixedJson);
                if (Array.isArray(fixedParsed)) {
                  console.log(`[✅ ${category} SALVAGED - ${fixedParsed.length} fields from truncated response]`);
                  console.log(`[📊 ${category} salvaged fields:`, fixedParsed.map(p => p.field).join(', '));
                  allResults.push(...fixedParsed);
                } else {
                  console.warn(`[⚠️ ${category}] Salvaged result is not an array`);
                }
              } else {
                console.warn(`[❌ ${category}] Could not find any complete objects in truncated JSON`);
              }
            } catch (salvageErr) {
              console.warn(`[❌ ${category}] Failed to salvage truncated JSON:`, salvageErr.message);
            }
          } else {
            console.warn(`[🔍 Raw response preview for ${category}]:`, cleanedResult.substring(0, 200) + '...');
          }
        }
        
      } catch (err) {
        console.error(`[❌ Failed to process category ${category}]`, err.message);
        
        // Add fallback comparison data for failed categories
        console.log(`[🔧 Creating fallback comparison data for ${category}]`);
        const fallbackFields = getFallbackComparisonFields(category);
        allResults.push(...fallbackFields);
      }
    }
    
    // Return combined results
    console.log(`[✅ Lotus LLM comparison complete - ${allResults.length} fields compared]`);
    console.log(`[📊 All comparison fields:`, allResults.map(r => r.field).join(', '));
    console.log(`[📈 Results per category:`, allResults.reduce((acc, r) => {
      const category = r.field.includes('Year') || r.field.includes('Total') ? 'lease_years' : 
                      (r.field === 'Lease Type' || r.field === 'Monthly charge' || r.field === 'Billing Frequency') ? 'lease_basic' :
                      r.field.includes('Deposit') || r.field.includes('tax') ? 'tax_deposits' :
                      r.field.includes('Utility') || r.field.includes('Include') ? 'utilities' :
                      r.field.includes('Service') || r.field.includes('charge') ? 'service_charges' : 'basic';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {}));
    res.json({ response: JSON.stringify(allResults) });
    
  } catch (err) {
    console.error('[❌ Gemini Compare Error]', err);
    res.status(500).json({ message: 'Gemini comparison failed', error: err.message });
  }
});

// ===== Modular Validation Endpoint =====
app.post('/api/validate-modular', async (req, res) => {
  console.log('[🔧 HIT /api/validate-modular]');
  const { extractedData, contractType, contractNumber, sourceType = 'pdf' } = req.body;
  
  if (!extractedData || typeof extractedData !== 'object') {
    console.error('[Modular Validation] Invalid extractedData:', extractedData);
    return res.status(400).json({ message: 'Invalid extracted data' });
  }
  
  if (!contractType) {
    console.error('[Modular Validation] Missing contractType');
    return res.status(400).json({ message: 'Contract type is required' });
  }
  
  try {
    // === Excel File Validations (Master_9_cell.xlsx, Master_PT.xlsx, bigtenant.xlsx) ===
    let excelValidationResults = [];
    const buildingId = extractedData['Building ID'];
    const brandName = extractedData['Brand Name'];
    const customerName = extractedData['Customer Name'];
    
    // 1) Master_9_cell.xlsx - Building ID check for deposit rules
    let buildingFoundInExcel = false;
    const masterExcelPath = path.join(__dirname, 'prompts', 'Master_9_cell.xlsx');
    if (fs.existsSync(masterExcelPath)) {
      console.log('[Modular Validation] Found Master_9_cell.xlsx; reading...');
      try {
        const workbook = xlsx.readFile(masterExcelPath);
        const firstSheetName = workbook.SheetNames[0];
        const masterData = xlsx.utils.sheet_to_json(workbook.Sheets[firstSheetName]);
        
        if (masterData.length > 0 && buildingId) {
          const firstColumnHeader = Object.keys(masterData[0])[0];
          buildingFoundInExcel = masterData.some(row => 
            String(row[firstColumnHeader]).trim() === String(buildingId).trim()
          );
          console.log(buildingFoundInExcel 
            ? `[Modular Validation] Building ID "${buildingId}" FOUND in Master_9_cell.xlsx`
            : `[Modular Validation] Building ID "${buildingId}" NOT FOUND in Master_9_cell.xlsx`
          );
        }
      } catch (err) {
        console.error('[Modular Validation] Error reading Master_9_cell.xlsx:', err);
      }
    }
    
    // 2) Master_PT.xlsx - Brand Name check for tax rules
    let brandFoundInPT = false;
    const ptExcelPath = path.join(__dirname, 'prompts', 'Master_PT.xlsx');
    if (fs.existsSync(ptExcelPath)) {
      console.log('[Modular Validation] Found Master_PT.xlsx; reading...');
      try {
        const wbPT = xlsx.readFile(ptExcelPath);
        const ptSheetName = wbPT.SheetNames[0];
        const ptData = xlsx.utils.sheet_to_json(wbPT.Sheets[ptSheetName]);
        
        if (ptData.length > 0 && brandName) {
          const secondColumnHeader = Object.keys(ptData[0])[1];
          brandFoundInPT = ptData.some(row => {
            const brandInSheet = String(row[secondColumnHeader] || '').trim().toLowerCase();
            return brandInSheet === String(brandName).trim().toLowerCase();
          });
          console.log(brandFoundInPT 
            ? `[Modular Validation] Brand Name "${brandName}" FOUND in Master_PT.xlsx`
            : `[Modular Validation] Brand Name "${brandName}" NOT FOUND in Master_PT.xlsx`
          );
        }
      } catch (err) {
        console.error('[Modular Validation] Error reading Master_PT.xlsx:', err);
      }
    }
    
    // 3) bigtenant.xlsx - Customer Name check for deposit rules
    let customerFoundInBigTenant = false;
    const bigTenantPath = path.join(__dirname, 'prompts', 'bigtenant.xlsx');
    if (fs.existsSync(bigTenantPath)) {
      console.log('[Modular Validation] Found bigtenant.xlsx; reading...');
      try {
        const wbBig = xlsx.readFile(bigTenantPath);
        const bigSheetName = wbBig.SheetNames[0];
        const bigTenantData = xlsx.utils.sheet_to_json(wbBig.Sheets[bigSheetName]);
        
        if (bigTenantData.length > 0 && customerName) {
          // Check all columns for customer name match (exact match, case-insensitive)
          customerFoundInBigTenant = bigTenantData.some(row => {
            return Object.values(row).some(cellValue => {
              if (cellValue === null || cellValue === undefined || cellValue === '') {
                return false;
              }
              const cellStr = String(cellValue).trim().toLowerCase();
              const customerStr = String(customerName).trim().toLowerCase();
              // Exact match only, no partial matches
              return cellStr !== '' && cellStr === customerStr;
            });
          });
          console.log(customerFoundInBigTenant 
            ? `[Modular Validation] Customer Name "${customerName}" FOUND in bigtenant.xlsx`
            : `[Modular Validation] Customer Name "${customerName}" NOT FOUND in bigtenant.xlsx`
          );
        }
      } catch (err) {
        console.error('[Modular Validation] Error reading bigtenant.xlsx:', err);
      }
    }

    // Use PromptManager to get validation prompts
    const promptManager = new PromptManager();
    const validationCategories = ['required', 'business', 'deposits'];
    
    // Add signature and citizen_id validation only for PDF (not available in web data)
    if (sourceType === 'pdf') {
      validationCategories.push('signatures', 'citizen_id');
    }
    
    // Use Lotus LLM API for validation
    const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
    const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';
    
    // Process each validation category separately
    const allValidationResults = [];
    console.log(`[🔄 Using chunked Lotus LLM validation for ${sourceType}]`);
    
    for (const category of validationCategories) {
      let finalPrompt; // Declare outside try block so catch can access it
      
      try {
        console.log(`[📊 Processing validation category: ${category}]`);
        let categoryPrompt = promptManager.createValidationPrompt(category, contractType, contractNumber, sourceType);
        
        if (!categoryPrompt) {
          console.log(`[⏭️ Skipping ${category} validation for ${sourceType} data]`);
          continue;
        }
        
        // Modify prompts based on Excel lookups
        if (category === 'deposits') {
          // Add Excel lookup context to deposit validation
          let excelContext = '\n--- EXCEL LOOKUP RESULTS ---\n';
          
          if (buildingFoundInExcel) {
            excelContext += `Building ID "${buildingId}" FOUND in Master_9_cell.xlsx - Apply 2× deposit rule instead of 3×\n`;
          } else {
            excelContext += `Building ID "${buildingId}" NOT FOUND in Master_9_cell.xlsx - Apply standard deposit rules\n`;
          }
          
          if (customerFoundInBigTenant) {
            excelContext += `Customer Name "${customerName}" FOUND in bigtenant.xlsx - Apply big tenant deposit requirements (3× minimum)\n`;
          } else {
            excelContext += `Customer Name "${customerName}" NOT FOUND in bigtenant.xlsx - Apply standard deposit rules\n`;
          }
          
          excelContext += '--- END EXCEL LOOKUPS ---\n\n';
          categoryPrompt = excelContext + categoryPrompt;
          
          // Update deposit rules based on Excel lookups
          if (customerFoundInBigTenant) {
            categoryPrompt += '\n\n**SPECIAL RULE**: Customer is in bigtenant.xlsx - deposit must be ≥ 3 × Monthly rental rate regardless of other rules.';
          } else if (buildingFoundInExcel) {
            categoryPrompt += '\n\n**SPECIAL RULE**: Building ID found in Master_9_cell.xlsx - minimum deposit requirement is 2 × Monthly rental rate instead of standard 3×.';
          }
        }
        
        if (category === 'business') {
          // Add Excel lookup context to business rules for tax validation
          let taxContext = '\n--- TAX VALIDATION CONTEXT ---\n';
          
          if (brandFoundInPT) {
            taxContext += `Brand Name "${brandName}" FOUND in Master_PT.xlsx - Lease property tax rate MUST be 0\n`;
          } else {
            taxContext += `Brand Name "${brandName}" NOT FOUND in Master_PT.xlsx - No special tax requirements\n`;
          }
          
          taxContext += '--- END TAX CONTEXT ---\n\n';
          categoryPrompt = taxContext + categoryPrompt;
          
          // Update tax validation rule
          if (brandFoundInPT) {
            categoryPrompt += '\n\n**SPECIAL TAX RULE**: Brand Name found in Master_PT.xlsx - "Lease property tax rate" must be exactly 0. If not 0, mark as invalid with reason: "Brand Name found in Master_PT.xlsx; Lease property tax rate must be zero".';
          }
        }
        
        finalPrompt = `${categoryPrompt}\n\nContract Data:\n${JSON.stringify(extractedData, null, 2)}`;
        
        // Add delay between requests to avoid overload
        if (allValidationResults.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay to reduce API load
        }
        
        const response = await axios.post(LOTUS_LLM_URL, {
          model: 'default',
          messages: [
            {
              role: 'system',
              content: 'You are a contract validation assistant. Return ONLY a valid JSON array without any markdown formatting, code blocks, or additional text. Do not use ```json or ``` markers.'
            },
            {
              role: 'user',
              content: finalPrompt
            }
          ],
          temperature: 0.1,
          max_tokens: 6000, // Further increased for complex validation responses
          extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
        }, {
          headers: {
            'Authorization': `Bearer ${LOTUS_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10800000 // 3 hours timeout (effectively infinite)
        });
        
        // Handle new API response format where content might be in reasoning_content
        const messageContent = response.data.choices[0].message.content;
        const reasoningContent = response.data.choices[0].message.reasoning_content;
        const categoryResult = messageContent || reasoningContent;
        console.log(`[✅ Validation category ${category} processed successfully]`);
        
        // Strip think tags first, then clean the response
        const withoutThinkTags = stripThinkTags(categoryResult);
        let cleanedResult = withoutThinkTags.trim();
        
        // Remove markdown code blocks if present
        if (cleanedResult.includes('```json')) {
          cleanedResult = cleanedResult.replace(/```json\s*/gi, '').replace(/```/g, '');
        } else if (cleanedResult.includes('```')) {
          cleanedResult = cleanedResult.replace(/```\s*/g, '');
        }
        
        // Remove any stray backticks
        cleanedResult = cleanedResult.replace(/`/g, '').trim();
        
        // Additional cleanup for malformed JSON
        // Handle case where there might be duplicate JSON arrays or extra content
        if (cleanedResult.includes('][')) {
          console.log(`[🔧 Validation ${category}] Found duplicate arrays, taking first valid array`);
          const firstArrayEnd = cleanedResult.indexOf('][');
          cleanedResult = cleanedResult.substring(0, firstArrayEnd + 1);
        }
        
        // Find the first complete JSON array if there's extra content after
        const firstBracket = cleanedResult.indexOf('[');
        if (firstBracket !== -1) {
          let bracketCount = 0;
          let endPos = firstBracket;
          
          for (let i = firstBracket; i < cleanedResult.length; i++) {
            if (cleanedResult[i] === '[') bracketCount++;
            else if (cleanedResult[i] === ']') bracketCount--;
            
            if (bracketCount === 0) {
              endPos = i + 1;
              break;
            }
          }
          
          if (endPos < cleanedResult.length) {
            console.log(`[🔧 Validation ${category}] Trimming extra content after JSON array`);
            cleanedResult = cleanedResult.substring(firstBracket, endPos);
          }
        }
        
        // Parse and merge results
        try {
          const parsed = JSON.parse(cleanedResult);
          if (Array.isArray(parsed)) {
            console.log(`[✅ Validation ${category} parsed successfully - ${parsed.length} checks]`);
            console.log(`[📊 Validation ${category} fields:`, parsed.map(p => p.field || p.issue || 'unknown').join(', '));
            allValidationResults.push(...parsed);
          } else {
            console.warn(`[⚠️ Validation category ${category} did not return an array]`);
          }
        } catch (parseErr) {
          console.warn(`[⚠️ Failed to parse validation category ${category} results]`, parseErr.message);
          console.warn(`[🔍 Raw validation response for ${category}]:`, cleanedResult.substring(0, 1000));
          console.warn(`[🔍 End of validation response for ${category}]:`, cleanedResult.substring(Math.max(0, cleanedResult.length - 200)));
          
          // Try to fix truncated JSON for validation
          if (parseErr.message.includes('Unexpected end of JSON input')) {
            console.log(`[🩹 Attempting AGGRESSIVE fix for validation ${category}]`);
            try {
              let fixedResult = cleanedResult.trim();
              
              // AGGRESSIVE: Remove any trailing incomplete text after last complete object
              let lastCompleteObjectEnd = fixedResult.lastIndexOf('}');
              if (lastCompleteObjectEnd > 0) {
                // Keep everything up to the last complete object
                let truncatedAtObject = fixedResult.substring(0, lastCompleteObjectEnd + 1);
                
                // Count brackets and braces in the truncated version
                const openBrackets = (truncatedAtObject.match(/\[/g) || []).length;
                const closeBrackets = (truncatedAtObject.match(/\]/g) || []).length;
                const openBraces = (truncatedAtObject.match(/\{/g) || []).length;  
                const closeBraces = (truncatedAtObject.match(/\}/g) || []).length;
                
                console.log(`[🔧 After truncation - Brackets: [${openBrackets}|${closeBrackets}], Braces: {${openBraces}|${closeBraces}}]`);
                
                // Add missing brackets
                if (openBrackets > closeBrackets) {
                  truncatedAtObject += ']' .repeat(openBrackets - closeBrackets);
                  console.log(`[🔧 Added ${openBrackets - closeBrackets} closing brackets]`);
                }
                
                fixedResult = truncatedAtObject;
                console.log(`[🔧 Final result length: ${fixedResult.length}]`);
                
                const salvagedParsed = JSON.parse(fixedResult);
                if (Array.isArray(salvagedParsed)) {
                  console.log(`[✅ AGGRESSIVE FIX SUCCESS - recovered ${salvagedParsed.length} validation items for ${category}]`);
                  allValidationResults.push(...salvagedParsed);
                } else {
                  console.warn(`[⚠️ Aggressive fix resulted in non-array for ${category}]`);
                }
              } else {
                console.warn(`[⚠️ No complete objects found in ${category} response]`);
              }
            } catch (fixErr) {
              console.warn(`[❌ Aggressive fix failed for ${category}:`, fixErr.message);
            }
          }
        }
        
      } catch (err) {
        console.error(`[❌ Failed to process validation category ${category}]`, err.message);
        
        // Handle 504 Gateway Timeout specifically
        if (err.response && err.response.status === 504) {
          console.log(`[🔄 Retrying ${category} with reduced token limit due to 504 timeout]`);
          try {
            // Safety check for finalPrompt
            if (!finalPrompt) {
              console.warn(`[⚠️ ${category}] finalPrompt is undefined, skipping retry`);
              continue;
            }
            
            // Create a shortened prompt for retry to avoid timeout
            const shortenedPrompt = `Validate contract fields and return JSON array. Be very concise.

Fields to validate: ${category}

Data: ${finalPrompt.substring(finalPrompt.indexOf('Data:') + 5, finalPrompt.indexOf('Data:') + 1500)}...

Return format: [{"field":"name","value":"val","valid":true/false,"reason":"brief"}]`;

            // Retry with very small max_tokens to avoid gateway timeout  
            const retryResponse = await axios.post(LOTUS_LLM_URL, {
              model: 'default',
              messages: [
                {
                  role: 'system',
                  content: 'Return ONLY valid JSON array. Be extremely concise.'
                },
                {
                  role: 'user',
                  content: shortenedPrompt
                }
              ],
              temperature: 0.1,
              max_tokens: 1000, // Further reduced to 1000
              extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
            }, {
              headers: {
                'Authorization': `Bearer ${LOTUS_API_KEY}`,
                'Content-Type': 'application/json'
              },
              timeout: 60000 // 60 second timeout instead of infinite
            });
            
            const retryResult = stripThinkTags(retryResponse.data.choices[0].message.content);
            console.log(`[🔄 ${category} retry response length:`, retryResult.length);
            
            const retryParsed = JSON.parse(retryResult);
            if (Array.isArray(retryParsed)) {
              allValidationResults.push(...retryParsed);
              console.log(`[✅ ${category} retry successful - ${retryParsed.length} validation items]`);
            }
          } catch (retryErr) {
            console.warn(`[⚠️ ${category} retry also failed:`, retryErr.message);
          }
        }
      }
    }
    
    // Add missing web validation fields if categories failed
    if (sourceType === 'web') {
      const expectedWebFields = [
        "Contract Number", "Customer Name", "Brand Name", "Building Name", "Unit ID", "Space (NLA)", 
        "Monthly Rental Rate", "Lease Type", "Building ID", "อยู่กองทรัสต์หรือไม่", "Customer Type", 
        "Space Design Type", "Unit Status", "Proposed lease commencement date", "Proposed lease expiry date", 
        "Monthly Service Rate", "Rental Deposit", "Service Deposit"
      ];
      
      const currentFields = allValidationResults.map(r => r.field || r.issue || '');
      const missingFields = expectedWebFields.filter(field => !currentFields.includes(field));
      
      if (missingFields.length > 0) {
        console.log(`[🔧 Adding ${missingFields.length} missing web validation fields]`);
        const fallbackValidations = missingFields.map(field => ({
          field: field,
          value: "Category parsing failed",
          valid: false,
          reason: "Validation category failed to parse - field not validated"
        }));
        allValidationResults.push(...fallbackValidations);
      }
    }
    
    // Return combined validation results
    console.log(`[✅ Lotus LLM validation complete - ${allValidationResults.length} validation checks]`);
    console.log(`[📊 All validation fields:`, allValidationResults.map(r => r.field || r.issue || 'unknown').join(', '));
    res.json({ validation: allValidationResults });
    
  } catch (err) {
    console.error('[❌ Modular Validation Error]', err);
    res.status(500).json({ message: 'Modular validation failed', error: err.message });
  }
});

// ===== Force Process Endpoint =====

const API_URL = process.env.API_URL || 'http://localhost:5001';
app.post('/api/force-process-contract', async (req, res) => {
  const { contractNumber, promptKey = 'LOI_permanent_fixed_fields' } = req.body;
  if (!contractNumber) {
    return res
      .status(400)
      .json({ success: false, message: 'Missing contractNumber in request body' });
  }

  const doProcess = async () => {
    // 1) Auto‐login to Simplicity so scrape‐URL calls will succeed
    const loginRes = await axios.post(`${API_URL}/api/scrape-login`, {
      systemType: 'simplicity',
      username:   'john.pattanakarn@lotuss.com',
      password:   'Gofresh@0725-19'
    });
    if (!loginRes.data.success) {
      throw new Error('Auto-login to Simplicity failed');
    }

    // 2) Run the exact same pipeline you use in your folder‐processor,
    //    but just for this one file.
    const filename = `${contractNumber}.pdf`;
    const ok = await processOneContract(filename, promptKey);
    if (!ok) {
      throw new Error(`Processing logic returned false for ${filename}`);
    }
  };

  try {
    try {
      await doProcess();
    } catch (err) {
      // if we timed out clicking the Lease menu, clear the session and retry once
      if (err.message.includes('Waiting for selector') && err.message.includes('li:nth-child(10) > a')) {
        console.warn('[WARN] Lease-menu timeout, clearing session and retrying...');
        browserSessions.delete('simplicity');
        await doProcess();
      } else {
        throw err;
      }
    }

    return res.json({
      success: true,
      message: `Forced processing and end–to–end pipeline complete for ${contractNumber}`
    });

  } catch (err) {
    console.error('[❌ Force Process Error]', err);
    return res.status(500).json({
      success: false,
      message: 'Force processing failed',
      error: err.message
    });
  }
});



app.post('/api/store-compare-result', async (req, res) => {
  const { contractNumber, compareResult } = req.body;
  if (!contractNumber) return res.status(400).json({ message: 'Missing contractNumber' });

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('vision_results').doc(docId).set({
      compare_result: compareResult
    }, { merge: true });

    res.json({ success: true, message: 'Comparison result saved' });
  } catch (err) {
    console.error('[Firestore Compare Save Error]', err);
    res.status(500).json({ message: 'Failed to save compare result', error: err.message });
  }
});

//Web validation
app.post('/api/web-validate', async (req, res) => {
  const { contractNumber, extractedData, promptKey = 'default' } = req.body;
  if (!contractNumber || !extractedData || typeof extractedData !== 'object') {
    console.error('[Web Validation] Missing or invalid input:', req.body);
    return res.status(400).json({ message: 'Missing contractNumber or invalid extractedData' });
  }

  try {
    // ─── 1) LOGIN / SESSION SETUP ─────────────────────────────────
    const systemType = 'simplicity';
    let browser, page;

    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
      console.log('[LOGIN] Reusing existing Simplicity session');
    } else {
      console.log('[LOGIN] No session—launching new full-screen browser');
      browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-fullscreen']
      });
      page = await browser.newPage();
      page.setDefaultTimeout(0); // Disable all timeouts
      page.setDefaultNavigationTimeout(0); // Disable navigation timeouts
      await page.setViewport({ width: 1920, height: 1080 });

      console.log('[LOGIN] Navigating to landing page');
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', {
        waitUntil: 'networkidle2'
      });

      console.log('[LOGIN] clicking “go to login”');
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
      await Promise.all([
        page.click('#lblToLoginPage'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
      ]);

      console.log('[LOGIN] entering username');
      await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });

      const continueSel1 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      console.log('[LOGIN] clicking Continue after username');
      await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
      await page.click(continueSel1);

      console.log('[LOGIN] entering password');
      await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
      await page.type('input#password', 'Gofresh@0725-19', { delay: 50 });

      const continueSel2 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      console.log('[LOGIN] clicking Continue after password');
      await Promise.all([
        page.click(continueSel2),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
      ]);

      console.log('[LOGIN] waiting for UI to settle');
      await new Promise(r => setTimeout(r, 10000));

      const postLoginHtml = await page.content();
      if (postLoginHtml.includes('Invalid login')) {
        console.error('[LOGIN] invalid credentials');
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      console.log('[LOGIN] success');
      browserSessions.set(systemType, { browser, page });
    }

    // ─── 2) GEMINI-BASED WEB VALIDATION ─────────────────────────────
    const promptFilePath = path.join(__dirname, 'prompts', 'LOI_Sim_validation.txt');
    if (!fs.existsSync(promptFilePath)) {
      console.error('[VALIDATION] prompt file missing');
      return res.status(400).json({ message: 'Validation prompt file not found.' });
    }
    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');
    const finalPrompt = `${promptTemplate}\n\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}`;

    console.log('[Web Validation] sending to Gemini');
    const gemRes = await model.generateContent(finalPrompt);
    let gemText = (await gemRes.response.text()).trim();
    if (gemText.startsWith('```json')) gemText = gemText.slice(7);
    if (gemText.endsWith('```'))      gemText = gemText.slice(0, -3);

    let parsedResult;
    try {
      parsedResult = JSON.parse(gemText);
      if (!Array.isArray(parsedResult)) throw new Error('Expected an array');
    } catch (err) {
      console.error('[Web Validation] parse error', err);
      return res.status(500).json({ message: 'Failed to parse Gemini output', raw: gemText });
    }
    console.log('[Web Validation] parsed result:', parsedResult);

    // ─── extract workflow status from parsedResult ────────────────
    const wfItem = parsedResult.find(
      row => row.field && row.field.toLowerCase() === 'workflow status'
    );
    const workflowStatus = wfItem ? wfItem.value : null;
    console.log('[Web Validation] workflow_status =', workflowStatus);

    // ─── 3) OPTIONAL “Meter” SCRAPE + GEMINI CHECK ─────────────────
    let utilityRaw = null;
    let meterValidation = null;

    // Debug the Include Utility field
    console.log('[Utility Debug] extractedData["Include Utility"]:', extractedData['Include Utility']);
    console.log('[Utility Debug] contractNumber:', contractNumber);
    console.log('[Utility Debug] contractNumber.includes("LO"):', contractNumber.includes('LO'));
    
    // Check for variations in utility field name and value
    const utilityValue = extractedData['Include Utility'] || extractedData['Utility'] || extractedData['Include utility'];
    const isUtilityYes = utilityValue && (utilityValue.toLowerCase() === 'yes' || utilityValue.toLowerCase().includes('yes'));
    
    console.log('[Utility Debug] utilityValue (normalized):', utilityValue);
    console.log('[Utility Debug] isUtilityYes:', isUtilityYes);
    
    if (isUtilityYes && contractNumber.includes('LO')) {
      console.log('[Utility] Include Utility=Yes & LO… → scraping Meter…');

      try {
        // 3.1 scroll so the Utilities button is visible
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        console.log('[Utility] scrolled down');
        await new Promise(r => setTimeout(r, 2000));

        // 3.2 click Utilities top-menu
        const utilSel = '#menu_MenuLiteralDiv > ul > li:nth-child(22) > a > div.cssmenu-item-label';
        console.log('[Utility] clicking Utilities top-menu');
        await page.waitForSelector(utilSel, { visible: true, timeout: 20000 });
        await page.click(utilSel);

        // 3.3 hover to expand submenu
        console.log('[Utility] hovering Utilities submenu');
        await page.evaluate(() => {
          const li = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(22)');
          li?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        await new Promise(r => setTimeout(r, 10000));

        // 3.4 click “Meter” submenu
        console.log('[Utility] clicking Meter submenu');
        const clickedMeter = await page.evaluate(() => {
          const menu = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(25) ul');
          if (!menu) return false;
          const a = Array.from(menu.querySelectorAll('a'))
            .find(x => x.textContent.trim() === 'Meter');
          if (a) { a.click(); return true; }
          return false;
        });
        if (!clickedMeter) throw new Error('Could not click Meter submenu');
        console.log('[Utility] Meter submenu clicked');

        // 3.5 wait & switch to bottom iframe
        await new Promise(r => setTimeout(r, 10000));
        const frameHandle = await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 20000 });
        const frame = await frameHandle.contentFrame();
       
        await new Promise(r => setTimeout(r, 10000));
// ─── 3.6 Combined Unit ID + Building ID search ────────────────────
console.log('[Utility] preparing combined Unit ID + Building ID search');

// wait for the main search box
await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 20000 });

// pull the 4-digit Building ID from your parsedResult
const buildingRow = parsedResult.find(r => r.field === 'Building ID');
const buildingId = buildingRow?.value || '';
console.log('[Utility] fetched Building ID:', buildingId);

// build the combined search string
const unitId = extractedData['Unit ID'] || '';
const combinedSearch = buildingId
  ? `${unitId} ${buildingId}`
  : unitId;

console.log('[Utility] entering combined search:', combinedSearch);

// clear & type the combined string
await frame.click('#panel_SimpleSearch_c1', { clickCount: 3 });
await frame.type('#panel_SimpleSearch_c1', combinedSearch, { delay: 50 });

// click the initial Search button
console.log('[Utility] clicking Search');
await frame.evaluate(() => {
  const btn = document.querySelector('a#panel_buttonSearch_bt');
  btn?.click();
});
await new Promise(r => setTimeout(r, 15000));

// scrape immediately
utilityRaw = await frame.evaluate(() => document.body.innerText);
console.log('[Utility] scraped raw after combined search:', utilityRaw);


        // 3.8 run Lotus LLM on that Meter page
        const meterPromptPath = path.join(__dirname, 'prompts', 'meter_check.txt');
        if (fs.existsSync(meterPromptPath)) {
          const meterTemplate = fs.readFileSync(meterPromptPath, 'utf8');
          const meterPrompt = `${meterTemplate}\n\nMeter page content:\n${utilityRaw}`;
          console.log('[Meter Validation] sending to Lotus LLM');
          
          // Use Lotus LLM API for meter validation
          const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
          const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';
          
          try {
            const response = await axios.post(LOTUS_LLM_URL, {
              model: 'default',
              messages: [
                {
                  role: 'user',
                  content: meterPrompt
                }
              ],
              extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
            }, {
              headers: {
                'Authorization': `Bearer ${LOTUS_API_KEY}`,
                'Content-Type': 'application/json'
              },
              timeout: 0 // No timeout - wait indefinitely
            });

            // Handle new API response format where content might be in reasoning_content
            const messageContent = response.data.choices[0].message.content;
            const reasoningContent = response.data.choices[0].message.reasoning_content;
            let mText = (messageContent || reasoningContent).trim();
            if (mText.startsWith('```json')) mText = mText.slice(7);
            if (mText.endsWith('```')) mText = mText.slice(0, -3);

            meterValidation = JSON.parse(mText);
            console.log('[Meter Validation] parsed:', meterValidation);
          } catch (e) {
            console.error('[Meter Validation] parse failed', e);
          }
        } else {
          console.warn('[Meter Validation] prompt file missing, skipping');
        }
      } catch (err) {
        console.error('[Utility] scrape failed, continuing:', err);
      }
    }

    // ─── 4) SAVE TO FIRESTORE ─────────────────────────────────────
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      web_validation_result: parsedResult,
      workflow_status: workflowStatus,
      utility_scrape: utilityRaw,
      meter_validation_result: meterValidation,
      updated_at: new Date()
    }, { merge: true });

    console.log(`[🔥] Web + utility + meter validation saved for ${docId}`);
    return res.json({
      success: true,
      validationResult: parsedResult,
      workflowStatus,
      utilityRaw,
      meterValidation
    });
  } catch (err) {
    console.error('[❌ /api/web-validate Error]', err);
    return res.status(500).json({ message: 'Web validation failed', error: err.message });
  }
});

app.get('/api/get-lead-statuses', async (req, res) => {
  try {
    const snapshot = await db.collection('compare_result').get();
    const statuses = {};
    snapshot.forEach(doc => {
      const data = doc.data();
      // contract_number in Firestore is stored without slashes
      statuses[data.contract_number] = data.lead_status || '';
    });
    return res.json({ success: true, statuses });
  } catch (err) {
    console.error('[GET Lead Statuses Error]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// Attached Document validation
app.post('/api/validate-document', async (req, res) => {
  try {
    const { extractedData, promptKey = 'default' } = req.body;

    if (!extractedData || typeof extractedData !== 'object') {
      console.error('[Validation] Invalid extractedData:', extractedData);
      return res.status(400).json({ message: 'Invalid extracted data' });
    }

    // === Load Validation Prompt Template ===
    const promptFilePath = path.join(__dirname, 'prompts', 'LOI_Doc_validation.txt');
    if (!fs.existsSync(promptFilePath)) {
      return res.status(400).json({ message: 'Validation prompt file not found.' });
    }
    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');

    // === 1) Read Master_9_cell.xlsx and determine if Building ID is present ===
    const masterExcelPath = path.join(__dirname, 'prompts', 'Master_9_cell.xlsx');
    let masterData = [];
    let firstColumnHeader = null;
    const buildingId = extractedData['Building ID'];
    req.buildingIdFoundInExcel = false;

    if (fs.existsSync(masterExcelPath)) {
      console.log('[Validation] Found Master_9_cell.xlsx; reading...');
      try {
        const workbook = xlsx.readFile(masterExcelPath);
        const firstSheetName = workbook.SheetNames[0];
        masterData = xlsx.utils.sheet_to_json(workbook.Sheets[firstSheetName]);
        console.log('[Validation] Master_9_cell.xlsx contents (first 5 rows):', masterData.slice(0, 5));

        if (masterData.length > 0) {
          firstColumnHeader = Object.keys(masterData[0])[0];
          console.log('[Validation] Detected first column header (column A):', firstColumnHeader);
        }

        if (buildingId && firstColumnHeader) {
          const found = masterData.some(row => {
            const cellValue = row[firstColumnHeader];
            return (
              cellValue !== undefined &&
              String(cellValue).trim() === String(buildingId).trim()
            );
          });
          req.buildingIdFoundInExcel = found;
          console.log(
            found
              ? `[Validation] Building ID "${buildingId}" FOUND in Master_9_cell.xlsx.`
              : `[Validation] Building ID "${buildingId}" NOT FOUND in Master_9_cell.xlsx.`
          );
        } else {
          if (!buildingId) {
            console.warn('[Validation] extractedData["Building ID"] is missing; skipping Excel lookup.');
          } else {
            console.warn('[Validation] Could not determine first column header; skipping Excel lookup.');
          }
        }
      } catch (excelErr) {
        console.error('[Validation] Error reading Master_9_cell.xlsx:', excelErr);
        req.buildingIdFoundInExcel = false;
      }
    } else {
      console.warn('[Validation] Master_9_cell.xlsx not found; skipping Excel lookup.');
      req.buildingIdFoundInExcel = false;
    }

    // === 2) Extract deposit-related fields and validate deposit ===
    const rawRate = extractedData['Monthly rental rate'];
    const rawDeposit = extractedData['Total Property Deposit'];
    const rawContractNumber = extractedData['Contract number'];
    const tenantSelection = extractedData['Tenant Selection'];

    const parseNumber = str => {
      if (typeof str === 'number') return str;
      if (typeof str !== 'string') return NaN;
      return parseFloat(str.replace(/[^0-9.]/g, '')) || NaN;
    };

    const rate = parseNumber(rawRate);
    const deposit = parseNumber(rawDeposit);
    let depositValid = true;
    let depositReason = '';

    // Helper to ignore decimals
    const roundIgnoreDecimal = num => Math.floor(num);

    const isLO = typeof rawContractNumber === 'string' && rawContractNumber.includes('LO');
    const isTenantNo = String(tenantSelection).trim().toLowerCase() === 'no';
    const buildingFound = Boolean(req.buildingIdFoundInExcel);

    if (isLO && isTenantNo) {
      // Exception 2: LO + Tenant Selection = No → requires 4×
      const expected = roundIgnoreDecimal(rate * 4);
      if (roundIgnoreDecimal(deposit) < expected) {
        depositValid = false;
        depositReason = `Contract Number contains LO and Tenant Selection = No; Total Property Deposit (${deposit}) is less than 4 × Monthly rental rate (${rate} × 4 = ${expected}).`;
      } else {
        depositValid = true;
        depositReason = `Contract Number contains LO and Tenant Selection = No; ${deposit} ≥ 4 × ${rate} (ignoring decimals).`;
      }
      console.log('[Validation] Deposit check (Exception 2):', depositReason);

    } else if (buildingFound) {
      // Exception 1: Building ID found → requires 2×
      const expected = roundIgnoreDecimal(rate * 2);
      if (roundIgnoreDecimal(deposit) < expected) {
        depositValid = false;
        depositReason = `Building ID ${buildingId} found in Master_9_cell.xlsx; Total Property Deposit (${deposit}) is less than 2 × Monthly rental rate (${rate} × 2 = ${expected}).`;
      } else {
        depositValid = true;
        depositReason = `Building ID ${buildingId} found in Master_9_cell.xlsx; ${deposit} ≥ 2 × ${rate} (ignoring decimals).`;
      }
      console.log('[Validation] Deposit check (Exception 1):', depositReason);

    } else {
      // Default rule: requires 3×
      const expected = roundIgnoreDecimal(rate * 3);
      if (roundIgnoreDecimal(deposit) < expected) {
        depositValid = false;
        depositReason = `Total Property Deposit (${deposit}) is less than 3 × Monthly rental rate (${rate} × 3 = ${expected}).`;
      } else {
        depositValid = true;
        depositReason = `Total Property Deposit (${deposit}) ≥ 3 × Monthly rental rate (${rate} × 3 = ${expected}).`;
      }
      console.log('[Validation] Deposit check (Default 3×):', depositReason);
    }

    // Attach the deposit check result
    req.depositValidation = {
      field: 'Total Property Deposit',
      value: rawDeposit,
      valid: depositValid,
      reason: depositReason
    };

    // === 3) Read Master_PT.xlsx and validate Lease property tax rate ===
    const taxExcelPath = path.join(__dirname, 'prompts', 'Master_PT.xlsx');
    let ptData = [];
    let brandList = [];
    const brandNameRaw = extractedData['Brand Name'];
    const rawTaxRate = extractedData['Lease property tax rate'];
    const taxRate = parseNumber(rawTaxRate);
    let taxValid = true;
    let taxReason = '';

    if (fs.existsSync(taxExcelPath)) {
      console.log('[Validation] Found Master_PT.xlsx; reading...');
      try {
        const wbPT = xlsx.readFile(taxExcelPath);
        const ptSheetName = wbPT.SheetNames[0];
        ptData = xlsx.utils.sheet_to_json(wbPT.Sheets[ptSheetName]);
        console.log('[Validation] Master_PT.xlsx contents (first 5 rows):', ptData.slice(0, 5));

        if (ptData.length > 0) {
          const secondColumnHeader = Object.keys(ptData[0])[1];
          console.log('[Validation] Detected second column header (column B):', secondColumnHeader);
          brandList = ptData.map(row => row[secondColumnHeader]).filter(v => v !== undefined && v !== null);
        }

        let foundInPT = false;
        if (brandNameRaw && brandList.length > 0) {
          foundInPT = brandList.some(b =>
            String(b).trim().toLowerCase() === String(brandNameRaw).trim().toLowerCase()
          );
        }

        if (foundInPT) {
          if (taxRate === 0) {
            taxValid = true;
            taxReason = `Brand Name "${brandNameRaw}" found in Master_PT.xlsx; Lease property tax rate (${taxRate}) is zero.`;
          } else {
            taxValid = false;
            taxReason = `Brand Name "${brandNameRaw}" found in Master_PT.xlsx; Lease property tax rate (${taxRate}) must be zero.`;
          }
          console.log('[Validation] Tax check (Brand in PT list):', taxReason);
        } else {
          console.log(
            `[Validation] Brand Name "${brandNameRaw}" NOT FOUND in Master_PT.xlsx; no tax check required.`
          );
          taxValid = true;
          taxReason = `Brand Name "${brandNameRaw}" not found in Master_PT.xlsx; no tax check required.`;
        }
      } catch (ptErr) {
        console.error('[Validation] Error reading Master_PT.xlsx:', ptErr);
        taxValid = true;
        taxReason = 'Error reading Master_PT.xlsx; skipping tax check.';
      }
    } else {
      console.warn('[Validation] Master_PT.xlsx not found; skipping tax lookup.');
      taxValid = true;
      taxReason = 'Master_PT.xlsx not found; skipping tax check.';
    }

    // Attach the tax check result
    req.taxValidation = {
      field: 'Lease property tax rate',
      value: rawTaxRate,
      valid: taxValid,
      reason: taxReason
    };

    // === 4) Build a modified prompt for Gemini that accounts for skips if needed ===
    let modifiedPromptTemplate = promptTemplate;

    // If Building ID not found, tell Gemini to skip deposit check
    if (!req.buildingIdFoundInExcel) {
      console.log(
        `[Validation] Overriding deposit rule because Building ID "${buildingId}" was not found in Master_9_cell.xlsx.`
      );
      modifiedPromptTemplate =
        `NOTE: Building ID "${buildingId}" was NOT found in Master_9_cell.xlsx. Skip the “Total Property Deposit” check entirely.\n\n` +
        promptTemplate;
    } else {
      console.log(
        `[Validation] Leaving deposit rule in place (Building ID "${buildingId}" was found).`
      );
    }

    // If Brand Name not found in PT, tell Gemini to skip tax check
    const brandFoundInPT = !taxReason.includes('not found');
    if (!brandFoundInPT) {
      console.log(
        `[Validation] Overriding tax rule because Brand Name "${brandNameRaw}" was not found in Master_PT.xlsx.`
      );
      modifiedPromptTemplate =
        `NOTE: Brand Name "${brandNameRaw}" was NOT found in Master_PT.xlsx. Skip the “Lease property tax rate” check entirely.\n\n` +
        modifiedPromptTemplate;
    } else {
      console.log(
        `[Validation] Leaving tax rule in place (Brand Name "${brandNameRaw}" was found).`
      );
    }

    // === 5) Final Gemini prompt and send to Gemini ===
    const finalPrompt =
      `${modifiedPromptTemplate}\n\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}`;

    const geminiRes = await model.generateContent({
  contents: [{ parts: [{ text: finalPrompt }] }],
  generationConfig: {
    temperature: 0.1,        // 🔽 Lower = less hallucination
    topK: 1,
    topP: 0.8,
    maxOutputTokens: 5000
  }
});
    let geminiText = (await geminiRes.response.text()).trim();

    // === 6) Strip any ```json fences if present ===
    if (geminiText.startsWith('```json')) {
      geminiText = geminiText.slice(7);
    }
    if (geminiText.endsWith('```')) {
      geminiText = geminiText.slice(0, -3);
    }
    geminiText = geminiText.trim();

    // === 7) Return deposit-check, tax-check, and Gemini result ===
    return res.json({
      validation: geminiText,
      depositCheck: req.depositValidation,
      taxCheck: req.taxValidation
    });
  } catch (err) {
    console.error('[Validation Error]', err);
    return res.status(500).json({ message: 'Validation failed', error: err.message });
  }
});

// Function to sanitize JSON and remove null fields or any invalid commas
function sanitizeJson(data) {
  const sanitized = {};
  Object.keys(data).forEach((key) => {
    const value = data[key];
    if (value !== null && value !== undefined) {
      sanitized[key] = value; // Keep valid fields
    } else {
      sanitized[key] = ''; // Set missing or null fields to empty string to avoid invalid JSON
    }
  });
  return sanitized;
}

// End of Attached Document validation

app.post('/api/refresh-contract-status', async (req, res) => {
  const { contractNumber } = req.body;
  if (!contractNumber) {
    return res.status(400).json({ message: 'Missing contractNumber' });
  }

  try {
    const systemType = 'simplicity';
    let browser, page;

    // ─── 1) LOGIN / SESSION SETUP ─────────────────────────────
    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
      console.log('[REFRESH] Reusing existing session');
    } else {
      console.log('[REFRESH] No session — performing login');
      // mirror your check-contract-status login logic here
      browser = await puppeteer.launch({ headless: false });
      page = await browser.newPage();
      page.setDefaultTimeout(0); // Disable all timeouts
      page.setDefaultNavigationTimeout(0); // Disable navigation timeouts
      console.log('[REFRESH] goto landing page');
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });

      console.log('[REFRESH] click “go to login”');
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
      await Promise.all([
        page.click('#lblToLoginPage'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
      ]);

      console.log('[REFRESH] enter username');
      await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });
      const cont1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      console.log('[REFRESH] click username Continue');
      await page.waitForSelector(cont1, { visible: true, timeout: 20000 });
      await page.click(cont1);

      console.log('[REFRESH] enter password');
      await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
      await page.type('input#password', 'Gofresh@0725-19', { delay: 50 });
      const cont2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      console.log('[REFRESH] click password Continue');
      await Promise.all([
        page.click(cont2),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
      ]);

      console.log('[REFRESH] login settled');
      await new Promise(r => setTimeout(r, 10000));

      const postLogin = await page.content();
      if (postLogin.includes('Invalid login')) {
        console.error('[REFRESH] Invalid credentials');
        await browser.close();
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      console.log('[REFRESH] login success');
      browserSessions.set(systemType, { browser, page });
    }

    // ─── 2) RELOAD / RESET FRAMEWORK ────────────────────────────
    console.log('[REFRESH] reloading landing page to clear old frames');
    await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 2000));

    // ─── 3) NAVIGATE TO LEASE → SUBMENU ────────────────────────
    console.log('[REFRESH] clicking Lease top menu');
    const leaseTop = '#menu_MenuLiteralDiv > ul > li:nth-child(10) > a';
    await page.waitForSelector(leaseTop, { visible: true, timeout: 15000 });
    await page.click(leaseTop);

    console.log('[REFRESH] hover Lease to expand');
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Lease');
      if (el) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const isOffer = contractNumber.includes('LO');
    const submenuText = isOffer ? 'Lease Offer' : 'Lease Renewal';
    console.log(`[REFRESH] clicking submenu "${submenuText}"`);
    const ok = await page.evaluate(text => {
      const link = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === text);
      if (link) { link.click(); return true; }
      return false;
    }, submenuText);
    if (!ok) throw new Error(`Could not click submenu: ${submenuText}`);
    await new Promise(r => setTimeout(r, 5000));

    // ─── 4) RE-ACQUIRE IFRAME & EXTRACT STATUS ─────────────────
    console.log('[REFRESH] waiting for search iframe');
    const iframeHandle = await page.waitForSelector('iframe[name="frameBottom"]', { visible: true, timeout: 20000 });
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('Could not get contentFrame()');

    console.log('[REFRESH] entering contract number');
    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 15000 });
    await frame.evaluate((cn) => {
      const inp = document.querySelector('#panel_SimpleSearch_c1');
      inp.value = cn;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, contractNumber);

    console.log('[REFRESH] clicking search');
    await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true, timeout: 10000 });
    await frame.click('a#panel_buttonSearch_bt');
    await new Promise(r => setTimeout(r, 5000));

    console.log('[REFRESH] extracting status cell');
    const statusXPath = isOffer
      ? '//*[@id="gridResults_gv"]/tbody/tr[2]/td[13]'
      : '//*[@id="gridResults_gv"]/tbody/tr[2]/td[12]';
    const statusText = await frame.evaluate(xpath => {
      const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue?.textContent.trim() ?? null;
    }, statusXPath);

    console.log(`[REFRESH] ${contractNumber} → "${statusText}"`);

    // ─── 5) SAVE BACK TO FIRESTORE ─────────────────────────────
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      workflow_status: statusText,
      updated_at: new Date()
    }, { merge: true });
    console.log(`[REFRESH] workflow_status updated in Firestore for ${docId}`);

    return res.json({ success: true, status: statusText });

  } catch (err) {
    console.error('[REFRESH] Error:', err);
    return res.status(500).json({ message: 'Failed to refresh contract status', error: err.message });
  }
});

app.post('/api/store-validation-result', async (req, res) => {
  const { contractNumber, validationResult } = req.body;
  if (!contractNumber) return res.status(400).json({ message: 'Missing contractNumber' });

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('vision_results').doc(docId).set({
      document_validation: validationResult
    }, { merge: true });

    res.json({ success: true, message: 'Validation result saved' });
  } catch (err) {
    console.error('[Firestore Validation Save Error]', err);
    res.status(500).json({ message: 'Failed to save validation result', error: err.message });
  }
});

// === Save comparison and validation result under compare_result ===
app.post('/api/save-compare-result', async (req, res) => {
  const {
    contractNumber,
    compareResult,
    pdfGemini,
    webGemini,
    validationResult,
    webValidationResult, // ✅ Add missing web validation field
    meterValidationResult, // ✅ Add missing meter validation field
    popupUrl // ✅ New field added
  } = req.body;

  if (!contractNumber) {
    return res.status(400).json({ message: 'Missing contractNumber' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');
    console.log('[Debug] Incoming save payload:', {
      contractNumber,
      compareResult: compareResult ? 'present' : 'missing',
      pdfGemini: pdfGemini ? 'present' : 'missing',
      webGemini: webGemini ? 'present' : 'missing',
      validationResult: Array.isArray(validationResult) ? `${validationResult.length} items` : 'missing',
      webValidationResult: Array.isArray(webValidationResult) ? `${webValidationResult.length} items` : 'missing',
      meterValidationResult: Array.isArray(meterValidationResult) ? `${meterValidationResult.length} items` : (meterValidationResult ? 'present but not array' : 'missing'),
      popupUrl
    });
    
    // Additional debug for meter validation
    if (meterValidationResult) {
      console.log('[Debug] meterValidationResult type:', typeof meterValidationResult);
      console.log('[Debug] meterValidationResult content preview:', JSON.stringify(meterValidationResult).substring(0, 200));
    }
    await db.collection('compare_result').doc(docId).set({
      timestamp: new Date(),
      contract_number: contractNumber,
      pdf_extracted: pdfGemini,
      web_extracted: webGemini,
      compare_result: compareResult,
      validation_result: validationResult,
      web_validation_result: webValidationResult, // ✅ Save web validation data
      meter_validation_result: meterValidationResult, // ✅ Save meter validation data
      popup_url: popupUrl || null
    }, { merge: true }); // ✅ ensure i
    console.log('[Firebase Save] Saving popup_url:', popupUrl);
    console.log(`[🔥 compare_result] Document saved: ${docId}`);
    res.json({ success: true, message: 'Comparison and validation result saved' });
  } catch (err) {
    console.error('[Firestore compare_result Save Error]', err);
    res.status(500).json({ message: 'Failed to save compare result', error: err.message });
  }
});

app.post('/api/save-extracted-data', async (req, res) => {
  try {
    const { contractNumber, geminiOutput, pdfData } = req.body;

    if (!contractNumber || !geminiOutput) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Save extracted data to Firebase or your database
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('extracted_data').doc(docId).set({
      contractNumber,
      geminiOutput,
      pdfData,
      timestamp: new Date(),
    });

    console.log(`[🔥 Firebase] Document saved as ID: ${docId}`);
    res.status(200).json({ success: true, message: 'Data saved successfully' });
  } catch (err) {
    console.error('[❌ Save Extracted Data Error]', err);
    res.status(500).json({ message: 'Error saving extracted data', error: err.message });
  }
});

app.post('/api/save-validation-result', async (req, res) => {
  const { contractNumber, validationResult } = req.body;

  if (!contractNumber || !validationResult) {
    return res.status(400).json({ message: 'Missing contractNumber or validationResult' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');

    await db.collection('compare_result').doc(docId).set({
      validation_result: validationResult,
      updated_at: new Date()
    }, { merge: true });

    console.log(`[🔥 compare_result] Validation result saved for: ${docId}`);
    res.json({ success: true, message: 'Validation result saved to compare_result' });
  } catch (err) {
    console.error('[Firestore validation-only save error]', err);
    res.status(500).json({ message: 'Failed to save validation result', error: err.message });
  }
});

app.post('/api/upload-file', upload_2.any(), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  // Return the list of filenames we wrote
  const saved = req.files.map(f => f.filename);
  res.json({ files: saved });
});

// —–––––––
// DELETE /api/delete-entry?path=<contracts|processed>/<filename.pdf>
// —–––––––
app.delete('/api/delete-entry', async (req, res) => {
  const requested = req.query.path; // e.g. contracts/1234_xxx.pdf
  if (!requested) {
    return res.status(400).json({ error: 'Path query required' });
  }

  // Ensure it’s under one of our two folders
  const parts = requested.split(/[\\/]/);
  if (!['contracts','processed'].includes(parts[0])) {
    return res.status(400).json({ error: 'Invalid delete path' });
  }

  const fullPath = path.join(__dirname, requested);
  try {
    // Check exists
    await fsPromises.access(fullPath);
    // Delete the file
    await fsPromises.unlink(fullPath);
    res.json({ message: 'Deleted', path: requested });
  } catch (err) {
    console.error('delete-entry error', err);
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/update-lead-status', async (req, res) => {
  const { contractNumber, leadStatus } = req.body;

  if (!contractNumber || !leadStatus) {
    return res.status(400).json({ message: 'Missing contractNumber or leadStatus' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');

    await db.collection('compare_result').doc(docId).set({
      lead_status: leadStatus,
      updated_at: new Date(),
    }, { merge: true });

    console.log(`[🔥 Lead Status] Updated lead_status for ${docId} to "${leadStatus}"`);
    res.json({ success: true, message: 'Lead status updated' });
  } catch (err) {
    console.error('[❌ Update Lead Status Error]', err);
    res.status(500).json({ message: 'Failed to update lead status', error: err.message });
  }
});
/*
app.post('/api/web-validate', async (req, res) => {
  try {
    const { contractNumber, extractedData, promptKey = 'default' } = req.body;

    if (!contractNumber || !extractedData || typeof extractedData !== 'object') {
      console.error('[Web Validation] Missing or invalid input:', req.body);
      return res.status(400).json({ message: 'Missing contractNumber or invalid extractedData' });
    }

    // === Load Validation Prompt Template ===
    const promptFilePath = path.join(__dirname, 'prompts', 'LOI_Sim_validation.txt');
    if (!fs.existsSync(promptFilePath)) {
      return res.status(400).json({ message: 'Validation prompt file not found.' });
    }

    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');
    const finalPrompt = `${promptTemplate}\n\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}`;

    // === Send to Gemini ===
    const geminiRes = await model.generateContent({
  contents: [{ parts: [{ text: finalPrompt }] }],
  generationConfig: {
    temperature: 0.1,        // 🔽 Lower = less hallucination
    topK: 1,
    topP: 0.8,
    maxOutputTokens: 5000
  }
});
    const geminiText = stripThinkTags(await geminiRes.response.text());

    // === Clean Gemini output ===
    let cleaned = geminiText.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

    let parsedResult;
    try {
      parsedResult = JSON.parse(cleaned);
      if (!Array.isArray(parsedResult)) {
        throw new Error('Expected validation result to be an array');
      }
    } catch (err) {
      console.error('[❌ Web Validation Parsing Error]', err);
      return res.status(500).json({ message: 'Failed to parse Gemini web validation output', raw: geminiText });
    }

    // === Save to Firebase ===
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      web_validation_result: parsedResult,
      updated_at: new Date()
    }, { merge: true });

    console.log(`[🔥 compare_result] Web validation result saved for: ${docId}`);
    res.json({ success: true, validationResult: parsedResult });
  } catch (err) {
    console.error('[❌ /api/web-validate Error]', err);
    res.status(500).json({ message: 'Web validation failed', error: err.message });
  }
});
*/

app.get('/api/get-compare-results', async (req, res) => {
  try {
    const snapshot = await db.collection('compare_result').orderBy('timestamp', 'desc').limit(100).get();
    
    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[🔥 get-compare-results error]', err);
    res.status(500).json({ message: 'Failed to fetch compare results', error: err.message });
  }
});
// Endpoint to check if the file exists in the 'compare_result' collection
app.get('/api/check-file-exists', async (req, res) => {
  try {
    const { filename } = req.query; // Expect filename as query parameter

    if (!filename) {
      return res.status(400).json({ message: 'Filename is required' });
    }

    // Check if the file exists in the 'compare_result' collection
    const snapshot = await db.collection('compare_result')
      .where('contract_number', '==', filename)
      .get();

    if (!snapshot.empty) {
      return res.json({ success: true, message: 'File already processed', exists: true });
    } else {
      return res.json({ success: false, message: 'File not processed yet', exists: false });
    }
  } catch (err) {
    console.error('[❌ Error checking file existence]', err);
    res.status(500).json({ message: 'Error checking file existence', error: err.message });
  }
});

// New endpoint to check if the file exists in Firebase (compare_result collection)
// In your server.js (or wherever your Express routes live):

app.get('/api/check-file-processed', async (req, res) => {
  const { filename } = req.query; // e.g. "5036_LO2502_00060.pdf"

  if (!filename) {
    return res.status(400).json({ message: 'Filename is required' });
  }

  // ── 0) Strip “.pdf” (if present) so our regex can match just the contract number ──
  const baseName = filename.replace(/\.pdf$/i, '');

  // ── 1) Now test: must be digits + "_" + (LO|LR) + digits + "_" + digits ──
  // e.g. "5036_LO2502_00060"
  const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
  if (!validPattern.test(baseName)) {
    // Skip anything that does NOT conform. Return processed:true so caller won’t wait.
    return res.json({ success: true, processed: true });
  }

  try {
    // 2) We know baseName matches “5036_LO2502_00060”
    const contractNumber = baseName; // already has no ".pdf"

    // 3) Fetch from Firestore under “compare_result/{contractNumber}”
    const docSnapshot = await db
      .collection('compare_result')
      .doc(contractNumber)
      .get();

    if (!docSnapshot.exists) {
      // no document → not yet processed
      return res.json({ success: true, processed: false });
    }

    // 4) Document exists: grab the three arrays
    const data = docSnapshot.data();
    const compareArr = Array.isArray(data.compare_result) ? data.compare_result : null;
    const webValArr = Array.isArray(data.web_validation_result) ? data.web_validation_result : null;
    const pdfValArr = Array.isArray(data.validation_result) ? data.validation_result : null;

    if (!compareArr || !webValArr || !pdfValArr) {
      // any missing → not fully done
      return res.json({ success: true, processed: false });
    }

    // 5) Check that every row in compare_result has match === true
    const allCompareMatch = compareArr.every(row => row.match === true);
    // 6) Check that every row in web_validation_result has valid === true
    const allWebValid = webValArr.every(row => row.valid === true);
    // 7) Check that every row in validation_result has valid === true
    const allPdfValid = pdfValArr.every(row => row.valid === true);

    const fullyPassed = allCompareMatch && allWebValid && allPdfValid;
    return res.json({ success: true, processed: fullyPassed });
  } catch (error) {
    console.error('[❌ Error in /api/check-file-processed]', error);
    return res.status(500).json({
      message: 'Error checking file processed status',
      error: error.message,
    });
  }
});

app.post('/api/process-sharepoint-folder', async (req, res) => {
  const { folderUrl } = req.body;

  try {
    const files = await fetchFilesFromSharePoint(folderUrl); // Implement this function
    const newContracts = [];

    for (const file of files) {
      const contractNumber = path.basename(file.name, '.pdf');
      const docId = contractNumber.replace(/\//g, '_');

      const docExists = await db.collection('compare_result').doc(docId).get();
      if (docExists.exists) {
        console.log(`✅ Skipping already-processed contract: ${contractNumber}`);
        continue;
      }

      const fileBuffer = await downloadSharePointFile(file.downloadUrl); // implement this

      const tempFilePath = path.join(__dirname, 'uploads', `${contractNumber}.pdf`);
      fs.writeFileSync(tempFilePath, fileBuffer);

      newContracts.push({ contractNumber, tempFilePath });
    }

    res.json({ success: true, contracts: newContracts });
  } catch (err) {
    console.error('[SharePoint Processing Error]', err);
    res.status(500).json({ message: 'Failed to fetch files from SharePoint', error: err.message });
  }
});


import { processOneContract } from './autoProcessor.js';
import axios from 'axios';  // To call the /api/check-file-exists endpoint
import SequentialProcessor from './sequentialProcessor.js';
import PromptManager from './promptManager.js';


app.post('/api/auto-process-pdf-folder', async (req, res) => {
  const FOLDER_PATH = path.join(process.cwd(), 'contracts');
  const files = fs.readdirSync(FOLDER_PATH).filter(f => f.toLowerCase().endsWith('.pdf'));
  const promptKey = req.body.promptKey || 'LOI_permanent_fixed_fields';

  // ✅ Use only the date for folder name
  const now = new Date();
  const dateOnly = now.toISOString().split('T')[0]; // e.g., '2025-05-10'
  const OUTPUT_BASE = path.join(process.cwd(), 'processed', dateOnly);
  const SKIPPED_FOLDER = path.join(OUTPUT_BASE, 'skipped');

  if (!fs.existsSync(SKIPPED_FOLDER)) {
    fs.mkdirSync(SKIPPED_FOLDER, { recursive: true });
    console.log(`[📁 Folder Created] ${SKIPPED_FOLDER}`);
  }

  if (!files.length) {
    return res.status(200).json({ success: false, message: 'No files to process.' });
  }

  let processedCount = 0;

  for (const file of files) {
    const fileNameWithoutExtension = path.basename(file, '.pdf');
    const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
    if (!validPattern.test(fileNameWithoutExtension)) {
      console.log(`[⏭️  Skipping invalid filename] ${fileNameWithoutExtension}`);

      

      // Don’t process this one—go to the next file
      continue;
    }

    const alreadyProcessed = await checkIfFileExistsInFirebase(fileNameWithoutExtension);

    if (alreadyProcessed) {
      console.log(`[❌ Skipping] ${fileNameWithoutExtension} has already been processed.`);
      continue;
    }

    console.log(`[📄 Processing] ${fileNameWithoutExtension}`);
    await processOneContract(file, promptKey);
    processedCount++;

    console.log('[⏳] Waiting for 90 seconds before processing the next file...');
    await new Promise(resolve => setTimeout(resolve, 90000));
  }

  return res.json({ success: true, processedCount, message: 'Processing completed.' });
});



// Function to check if the file exists in the Firebase 'compare_result' collection
async function checkIfFileExistsInFirebase(filename) {
  const contractNumber = filename.replace(/\.pdf$/, '');
  const filePath = path.join(FOLDER_PATH, `${contractNumber}.pdf`);
  const docId = contractNumber.replace(/\//g, '_');

  try {
    // ✅ STEP 1: Check if exists in compare_result
    console.log(`[STEP 1] 🔍 Checking if ${docId} exists in compare_result...`);
    const existingDoc = await db.collection('compare_result').doc(docId).get();

    if (existingDoc.exists) {
      console.log(`[✅ STEP 1: Found] ${contractNumber} exists in compare_result.`);

      // ✅ STEP 2: Compare modified timestamp
      console.log(`[STEP 2] 🕒 Comparing modified time for ${contractNumber}...`);
      const fileModifiedTime = fs.statSync(filePath).mtime;

      const timestampRes = await axios.get('http://localhost:5001/api/check-file-timestamp', {
        params: { filename: contractNumber },
      });

      const { exists, updatedAt } = timestampRes.data;

      if (exists && updatedAt) {
        const firebaseDate = new Date(updatedAt);
        console.log(`[STEP 2] 🔄 File modified: ${fileModifiedTime.toISOString()} vs Firebase: ${firebaseDate.toISOString()}`);

        if (firebaseDate >= fileModifiedTime) {
          console.log(`[❌ Skipping] Firebase timestamp is newer or equal. ${contractNumber} already processed.`);
          return true;
        } else {
          console.log(`[⚠️ STEP 2: Firebase is older] Proceeding to check contract status.`);
        }
      } else {
        console.log(`[⚠️ STEP 2: No timestamp] Proceeding to check contract status.`);
      }
    } else {
      console.log(`[✅ STEP 1: Not found] ${contractNumber} not yet in compare_result. Skipping timestamp check.`);
    }

    // ✅ STEP 3: Check Simplicity contract status
    console.log(`[STEP 3] 📄 Checking Simplicity status for ${contractNumber}...`);
    const statusRes = await axios.post('http://localhost:5001/api/check-contract-status', { contractNumber });
    const contractStatus = statusRes.data?.status || '';

    console.log(`[STEP 3] 🔍 Contract status = "${contractStatus}"`);
    /*
    if (contractStatus.trim() !== 'Pending Verification') {
      console.log(`[🚫 Skipping] ${contractNumber} status is not 'Pending Verification'.`);
      return true;
    }
    */

    console.log(`[✅ PASSED] ${contractNumber} ready for processing.`);
    return false;
  } catch (error) {
    console.error(`[❌ ERROR] ${contractNumber}:`, error.message);
    return false; // Fail-safe: continue processing
  }
}

app.post('/api/update-verified-status', async (req, res) => {
  const { contractNumber, verifiedStatus } = req.body;
  if (!contractNumber || !verifiedStatus) {
    return res.status(400).json({ message: 'Missing fields' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set(
      { verified_status: verifiedStatus },
      { merge: true }
    );
    console.log(`[Firebase] Set verified_status="${verifiedStatus}" for ${docId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Firestore Error] update-verified-status:', err);
    return res.status(500).json({ message: err.message });
  }
});


app.post('/api/check-contract-status', async (req, res) => {
  // 1) Read `contractNumber` explicitly from req.body
  const contractNumber = req.body.contractNumber;
  if (!contractNumber) {
    return res.status(400).json({ message: 'Missing contractNumber' });
  }
  const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
  if (!validPattern.test(contractNumber)) {
    // Return “processed” right away so the caller won’t launch Puppeteer
    return res.json({
      success: true,
      status: null,
      message: 'Skipped: invalid filename format'
    });
  }

  try {
    const systemType = 'simplicity';
    let browser, page;

    // Hoist these selectors so both login branches can use them
    const continueSel1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
    const continueSel2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';

    // ─── 1) LOGIN OR RELOAD ─────────────────────────────────────────────────────────────
    if (!browserSessions.has(systemType)) {
      // Fresh login
      console.log('[STEP] launching browser/session');
      browser = await puppeteer.launch({ headless: false });
      page = await browser.newPage();
      page.setDefaultTimeout(0); // Disable all timeouts
      page.setDefaultNavigationTimeout(0); // Disable navigation timeouts

      console.log('[STEP] going to apptop.aspx');
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });

      console.log('[STEP] waiting for "go to login" button');
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
      console.log('[STEP] clicking "go to login"');
      await page.click('#lblToLoginPage');

      console.log('[STEP] waiting 5s for username form');
      await new Promise(r => setTimeout(r, 5000));

      console.log('[STEP] typing username');
      await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });
      await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
      console.log('[STEP] clicking username Continue');
      await page.click(continueSel1);

      console.log('[STEP] waiting 5s for password form');
      await new Promise(r => setTimeout(r, 5000));

      console.log('[STEP] typing password');
      await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
      await page.type('input#password', 'Gofresh@0725-19', { delay: 50 });
      await page.waitForSelector(continueSel2, { visible: true, timeout: 20000 });
      console.log('[STEP] clicking password Continue');
      await page.click(continueSel2);

      console.log('[STEP] waiting 15s for post-login settle');
      await new Promise(r => setTimeout(r, 15000));

      console.log('[STEP] verifying login succeeded');
      const html = await page.content();
      if (html.includes('Invalid login')) {
        console.log('[ERROR] Invalid credentials');
        await browser.close();
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      console.log('[STEP] storing session');
      browserSessions.set(systemType, { browser, page });

    } else {
      // Reuse or fallback login
      console.log('[STEP] reusing existing session');
      try {
        ({ browser, page } = browserSessions.get(systemType));

        // Close any extra tabs/popups so we start fresh
        const pagesNow = await browser.pages();
        for (let i = 1; i < pagesNow.length; i++) {
          try { await pagesNow[i].close(); } catch {}
        }

        // Reload the landing page to clear old iframes/state
        await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });
        await page.waitForTimeout(2000);

      } catch (reuseErr) {
        console.warn('[WARN] Existing session invalid, clearing and re-logging in:', reuseErr.message);
        browserSessions.delete(systemType);

        // Fallback to fresh login logic
        console.log('[STEP] launching browser/session');
        browser = await puppeteer.launch({ headless: false });
        page = await browser.newPage();
        page.setDefaultTimeout(0); // Disable all timeouts
        page.setDefaultNavigationTimeout(0); // Disable navigation timeouts

        console.log('[STEP] going to apptop.aspx');
        await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });

        console.log('[STEP] waiting for "go to login" button');
        await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
        console.log('[STEP] clicking "go to login"');
        await page.click('#lblToLoginPage');

        console.log('[STEP] waiting 5s for username form');
        await new Promise(r => setTimeout(r, 5000));

        console.log('[STEP] typing username');
        await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
        await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });
        await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
        console.log('[STEP] clicking username Continue');
        await page.click(continueSel1);

        console.log('[STEP] waiting 5s for password form');
        await new Promise(r => setTimeout(r, 5000));

        console.log('[STEP] typing password');
        await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
        await page.type('input#password', 'Gofresh@0725-19', { delay: 50 });
        await page.waitForSelector(continueSel2, { visible: true, timeout: 20000 });
        console.log('[STEP] clicking password Continue');
        await page.click(continueSel2);

        console.log('[STEP] waiting 15s for post-login settle');
        await new Promise(r => setTimeout(r, 15000));

        console.log('[STEP] verifying login succeeded');
        const html2 = await page.content();
        if (html2.includes('Invalid login')) {
          console.log('[ERROR] Invalid credentials');
          await browser.close();
          return res.status(401).json({ message: 'Invalid credentials' });
        }

        console.log('[STEP] storing session');
        browserSessions.set(systemType, { browser, page });
      }
    }

    // Small buffer before interacting
    await new Promise(r => setTimeout(r, 10000));

    // ─── STATUS CHECK ────────────────────────────────────────────────────────
    console.log('[STEP] clicking Lease menu');
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    console.log('[STEP] hovering Lease submenu');
    await new Promise(r => setTimeout(r, 5000));
    await page.evaluate(() => {
      const leaseMenu = [...document.querySelectorAll('a')].find(el => el.textContent.trim() === 'Lease');
      leaseMenu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 10000));

    // Decide Offer vs Renewal
    const isLeaseOffer = contractNumber.includes('LO');
    const submenuText = isLeaseOffer ? 'Lease Offer' : 'Lease Renewal';
    console.log(`[STEP] clicking submenu "${submenuText}"`);
    const clicked = await page.evaluate(text => {
      const link = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === text);
      if (link) { link.click(); return true; }
      return false;
    }, submenuText);
    if (!clicked) {
      throw new Error(`Could not click submenu: ${submenuText}`);
    }
    await new Promise(r => setTimeout(r, 5000));

    console.log('[STEP] waiting for search iframe');
    const iframeHandle = await page.waitForSelector(
      'iframe[name="frameBottom"]',
      { visible: true, timeout: 20000 }
    );
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('Could not get contentFrame()');

    console.log('[STEP] waiting for search input inside iframe (up to 50 s)…');
    let searchFound = false;
    try {
      await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 50000 });
      searchFound = true;
    } catch (cssErr) {
      console.warn('[WARN] CSS selector not found after 50s:', cssErr.message);
      try {
        await frame.waitForXPath('//*[@id="panel_SimpleSearch_c1"]', { visible: true, timeout: 10000 });
        searchFound = true;
      } catch {}
    }

    if (!searchFound) {
      console.error('[ERROR] Search box not found; skipping status check.');
      return res.json({
        success: true,
        status: null,
        message: 'Search box not found; cannot extract workflow status at this time.'
      });
    }

    console.log('[STEP] entering contract number');
    await frame.evaluate((cn) => {
      const inp = document.querySelector('#panel_SimpleSearch_c1');
      if (inp) {
        inp.value = cn;
        inp.focus();
      }
    }, contractNumber);

    console.log('[STEP] clicking search button');
    await frame.evaluate(() => document.querySelector('a#panel_buttonSearch_bt')?.click());
    await new Promise(r => setTimeout(r, 5000));

    console.log('[STEP] extracting status cell');
    const statusXPath = isLeaseOffer
      ? '//*[@id="gridResults_gv"]/tbody/tr[2]/td[13]'
      : '//*[@id="gridResults_gv"]/tbody/tr[2]/td[12]';
    const statusText = await frame.evaluate(xpath => {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue?.textContent.trim() || null;
    }, statusXPath);

    console.log(`[RESULT] ${contractNumber} → "${statusText}"`);
    return res.json({ success: true, status: statusText });

  } catch (err) {
    console.error('[ERROR] Contract status check failed:', err);
    return res.status(500).json({ message: 'Failed to check contract status', error: err.message });
  }
});

app.get('/api/list-directories', async (req, res) => {
  const base = process.cwd(); // or wherever your folders live
  const requested = req.query.path || '';
  const full = path.join(base, requested);
  try {
    const items = await fs.promises.readdir(full, { withFileTypes: true });
    const entries = items.map(dirent => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
    }));
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ message: 'Unable to list directory', error: err.message });
  }
});

// List the files in a folder
app.get('/api/list-files', async (req, res) => {
  const folder = req.query.folder;
  if (!['contracts','processed'].includes(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }

  // resolve relative to this file’s directory (safer than process.cwd())
  const dir = path.join(__dirname, folder);

  try {
    const files = await fsPromises.readdir(dir);
    const pdfs  = files.filter(f => f.toLowerCase().endsWith('.pdf'));
    res.json({ files: pdfs });
  } catch (err) {
    console.error('list-files error', err);
    res.status(500).json({ error: err.message });
  }
});



// The /api/check-file-exists endpoint in your server (if not added already)
app.get('/api/check-file-exists', async (req, res) => {
  try {
    const { filename } = req.query; // Expect filename as query parameter

    if (!filename) {
      return res.status(400).json({ message: 'Filename is required' });
    }

    // Check if the file exists in the 'compare_result' collection
    const snapshot = await db.collection('compare_result')
      .where('contract_number', '==', filename)  // Use the contract number without .pdf
      .get();

    if (!snapshot.empty) {
      return res.json({ success: true, message: 'File already processed', exists: true });
    } else {
      return res.json({ success: false, message: 'File not processed yet', exists: false });
    }
  } catch (err) {
    console.error('[❌ Error checking file existence]', err);
    res.status(500).json({ message: 'Error checking file existence', error: err.message });
  }
});

app.get('/api/check-file-timestamp', async (req, res) => {
  try {
    const { filename } = req.query;

    if (!filename) {
      return res.status(400).json({ message: 'Filename (contract number) is required' });
    }

    // Query Firestore for the document with the matching contract number
    const snapshot = await db.collection('compare_result')
      .where('contract_number', '==', filename)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: false,
        exists: false,
        message: 'No matching document found'
      });
    }

    const doc = snapshot.docs[0].data();

    const updatedAt = doc.updated_at?.seconds
      ? new Date(doc.updated_at.seconds * 1000)
      : (doc.updated_at ? new Date(doc.updated_at) : null);

    if (!updatedAt) {
      return res.status(200).json({
        success: true,
        exists: true,
        updatedAt: null,
        message: 'Document found, but no updated_at field'
      });
    }

    return res.status(200).json({
      success: true,
      exists: true,
      updatedAt: updatedAt.toISOString(),
      message: 'Timestamp fetched successfully'
    });
  } catch (err) {
    console.error('[❌ Error in /api/check-file-timestamp]', err);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message
    });
  }
});


app.post('/api/update-workflow-status', async (req, res) => {
  const { contractNumber, workflowStatus } = req.body;
  if (!contractNumber || !workflowStatus) {
    return res.status(400).json({ success: false, message: 'Missing contractNumber or workflowStatus' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set(
      { workflow_status: workflowStatus },
      { merge: true }
    );
    console.log(`[✅ Firestore] workflow_status for ${docId} set to "${workflowStatus}"`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[❌ Failed to update workflow_status for ${contractNumber}]:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});



app.post('/api/contract-classify', async (req, res) => {
  try {
    const { ocrText } = req.body;
    if (!ocrText) return res.status(400).json({ error: 'Missing OCR text' });

    const classifyPromptPath = path.join(__dirname, 'prompts', 'LOI_classify_prompt.txt');
    const promptTemplate = fs.readFileSync(classifyPromptPath, 'utf-8');

    const fullPrompt = `${promptTemplate.trim()}\n\n${ocrText.trim()}`;

    // Use Lotus LLM API instead of Gemini
    const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
    const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';

    let text;
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[🔄 Attempting contract classification with Lotus LLM - attempt ${attempt}/${maxRetries}]`);
        
        const response = await axios.post(LOTUS_LLM_URL, {
          model: 'default',
          messages: [
            {
              role: 'system',
              content: 'You are a contract classification assistant. Always respond with valid JSON only.'
            },
            {
              role: 'user',
              content: fullPrompt
            }
          ],
          temperature: 0.1,
          max_tokens: 500,
          extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
        }, {
          headers: {
            'Authorization': `Bearer ${LOTUS_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 0 // No timeout - wait indefinitely
        });

        // Handle new API response format where content might be in reasoning_content
        const messageContent = response.data.choices[0].message.content;
        const reasoningContent = response.data.choices[0].message.reasoning_content;
        text = messageContent || reasoningContent;
        console.log('[✅ Contract classification Lotus LLM API call successful]');
        break;
      } catch (fetchError) {
        console.warn(`[⚠️ Contract classification attempt ${attempt}/${maxRetries} failed]`, fetchError.message);
        
        if (attempt === maxRetries) {
          console.error('[❌ All contract classification attempts failed]');
          
          // Fallback: Use rule-based classification when Lotus LLM is unavailable
          if (fetchError.response && (fetchError.response.status === 503 || fetchError.response.status === 502)) {
            console.log('[🔄 Lotus LLM unavailable (503/502), using fallback rule-based classification]');
            
            // Simple rule-based classification based on content patterns
            const content = fullPrompt.toLowerCase();
            let contractType = 'permanent_fixed'; // default
            
            // Check for service express indicators
            if (content.includes('service express') || content.includes('service_express') || 
                content.includes('monthly service') && content.includes('short term')) {
              contractType = 'service_express';
            }
            
            console.log('[✅ Fallback classification completed]', { contractType });
            return res.json({ contractType });
          }
          
          throw new Error(`Contract classification Lotus LLM API failed after ${maxRetries} attempts: ${fetchError.message}`);
        }
        
        // Wait before retry (longer wait for 503/502 service unavailable errors)
        let waitTime;
        if (fetchError.response && (fetchError.response.status === 503 || fetchError.response.status === 502)) {
          waitTime = 5000 * attempt; // 5s, 10s, 15s for service unavailable
        } else {
          waitTime = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s for other errors
        }
        console.log(`[⏳ Contract classification waiting ${waitTime}ms before retry...]`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // Handle successful LLM response
    if (text) {
      // Clean and parse LLM response
      let raw = text.trim();
      if (raw.startsWith('```json')) raw = raw.slice(7);
      if (raw.endsWith('```')) raw = raw.slice(0, -3);

      const jsonBlock = raw.substring(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonBlock);

      const contractType = parsed?.contractType?.trim() || parsed?.['Contract Type']?.trim();
      if (!contractType) {
        console.error('[Contract Classification] Parsed response:', parsed);
        throw new Error('No contractType found in LLM output');
      }

      res.json({ contractType });
    } else {
      // This should not happen due to fallback, but just in case
      console.error('[Contract Classification] No response text available');
      throw new Error('No classification response available');
    }
  } catch (err) {
    console.error('[❌ Contract Classification Error]', err);
    res.status(500).json({ error: err.message });
  }
});


// Meter check endpoint for autoProcessor
app.post('/api/meter-check', async (req, res) => {
  console.log('[Meter Check] Incoming request to /api/meter-check');
  const { contractNumber, contractType, unitId, buildingId } = req.body;

  if (!contractNumber) {
    return res.status(400).json({ success: false, message: 'Contract number required' });
  }

  let browser;
  try {
    // Reuse existing browser session or create new one
    const systemType = 'simplicity';
    if (browserSessions.has(systemType)) {
      const session = browserSessions.get(systemType);
      
      try {
        if (!session || !session.browser || typeof session.browser.pages !== 'function') {
          throw new Error('Browser session invalid');
        }
        await session.browser.pages();
        browser = session.browser;
      } catch (browserError) {
        console.warn('[Meter Check] Existing browser session invalid, using existing logic');
        browserSessions.delete(systemType);
        return res.status(400).json({ 
          success: false, 
          message: 'No active browser session. Please ensure web scraping session is active.' 
        });
      }
    } else {
      return res.status(400).json({ 
        success: false, 
        message: 'No active browser session found. Please run web scraping first.' 
      });
    }

    // Find the simplicity popup
    const pages = await browser.pages();
    let popup = pages.find(page => page.url().includes('simplicity') || page.url().includes('mall-management'));
    
    if (!popup) {
      return res.status(400).json({ 
        success: false, 
        message: 'No active Simplicity page found. Please ensure web scraping session is active.' 
      });
    }

    console.log('[Meter Check] Using existing popup:', popup.url());

    // Navigate to meter page
    await popup.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    console.log('[Meter Check] scrolled down');
    await new Promise(r => setTimeout(r, 2000));

    // Wait a bit to ensure page is ready
    await new Promise(r => setTimeout(r, 3000));
    
    // Click Utility menu (at position 25, not 22)
    const utilSel = '#menu_MenuLiteralDiv > ul > li:nth-child(25) > a > div.cssmenu-item-label';
    console.log('[Meter Check] clicking Utility top-menu');
    
    try {
      await popup.waitForSelector(utilSel, { visible: true, timeout: 10000 });
      await popup.click(utilSel);
      console.log('[Meter Check] Successfully clicked Utility menu');
    } catch (utilError) {
      console.error('[Meter Check] Failed to click Utility menu:', utilError.message);
      throw new Error(`Failed to click Utility menu: ${utilError.message}`);
    }

    // Hover to expand submenu
    console.log('[Meter Check] hovering Utility submenu');
    await popup.evaluate(() => {
      const li = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(25)');
      if (li) {
        li.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        console.log('[Page] Dispatched mouseover on utility menu');
      } else {
        console.log('[Page] Could not find utility menu li element');
      }
    });
    await new Promise(r => setTimeout(r, 5000)); // Wait for submenu to appear

    // Click "Meter" submenu
    console.log('[Meter Check] clicking Meter submenu');
    const clickedMeter = await popup.evaluate(() => {
      const menu = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(25) ul');
      console.log('[Page] Found submenu container:', !!menu);
      if (!menu) return false;
      
      const allLinks = Array.from(menu.querySelectorAll('a'));
      console.log('[Page] Found links in submenu:', allLinks.map(a => a.textContent.trim()));
      
      const meterLink = allLinks.find(x => x.textContent.trim() === 'Meter');
      console.log('[Page] Found Meter link:', !!meterLink);
      
      if (meterLink) { 
        meterLink.click(); 
        return true; 
      }
      return false;
    });
    
    if (!clickedMeter) {
      throw new Error('Could not find or click Meter submenu item');
    }
    console.log('[Meter Check] Meter submenu clicked');

    // Wait & switch to bottom iframe
    await new Promise(r => setTimeout(r, 10000));
    const frameHandle = await popup.waitForSelector('iframe[name="frameBottom"]', { timeout: 20000 });
    const frame = await frameHandle.contentFrame();
   
    await new Promise(r => setTimeout(r, 10000));

    // Combined Unit ID + Building ID search
    console.log('[Meter Check] preparing combined Unit ID + Building ID search');

    // Wait for the main search box
    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 20000 });

    // Use the passed Unit ID and Building ID from autoProcessor
    console.log('[Meter Check] received Unit ID:', unitId);
    console.log('[Meter Check] received Building ID:', buildingId);

    // Build the combined search string
    const combinedSearch = buildingId && unitId ? `${unitId} ${buildingId}` : contractNumber.replace(/\//g, '');

    console.log('[Meter Check] entering combined search:', combinedSearch);

    // Clear & type the combined string
    await frame.click('#panel_SimpleSearch_c1', { clickCount: 3 });
    await frame.type('#panel_SimpleSearch_c1', combinedSearch, { delay: 50 });

    // Click search button
    console.log('[Meter Check] clicking Search');
    await frame.evaluate(() => {
      const btn = document.querySelector('a#panel_buttonSearch_bt');
      btn?.click();
    });
    await new Promise(r => setTimeout(r, 15000));

    // Scrape meter page content
    const utilityRaw = await frame.evaluate(() => document.body.innerText);
    console.log('[Meter Check] scraped meter content, length:', utilityRaw.length);

    // Run meter validation using Lotus LLM
    const meterPromptPath = path.join(__dirname, 'prompts', 'meter_check.txt');
    let meterValidation = null;
    
    if (fs.existsSync(meterPromptPath)) {
      const meterTemplate = fs.readFileSync(meterPromptPath, 'utf8');
      const meterPrompt = `${meterTemplate}\n\nMeter page content:\n${utilityRaw}`;
      console.log('[Meter Check] sending to Lotus LLM');
      
      const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
      const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';
      
      const response = await axios.post(LOTUS_LLM_URL, {
        model: 'default',
        messages: [
          {
            role: 'user',
            content: meterPrompt
          }
        ],
        temperature: 0.1,
        max_tokens: 2000,
        extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LOTUS_API_KEY}`
        },
        timeout: 0 // No timeout - wait indefinitely
      });

      // Handle new API response format where content might be in reasoning_content
      const messageContent = response.data.choices[0].message.content;
      const reasoningContent = response.data.choices[0].message.reasoning_content;
      const meterResponse = (messageContent || reasoningContent).trim();
      console.log('[Meter Check] Lotus LLM response received');

      try {
        // Clean the response to extract JSON if it's embedded in text
        let cleanedResponse = meterResponse.trim();
        
        // If response starts with explanatory text, try to find JSON array
        if (cleanedResponse.startsWith("Here's") || cleanedResponse.startsWith("Based on")) {
          const jsonMatch = cleanedResponse.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            cleanedResponse = jsonMatch[0];
          }
        }
        
        // Remove markdown code fences if present
        cleanedResponse = cleanedResponse.replace(/^```json\s*/i, '').replace(/```$/g, '');
        
        console.log('[Meter Check] Attempting to parse:', cleanedResponse.substring(0, 200));
        meterValidation = JSON.parse(cleanedResponse);
        console.log('[Meter Check] validation parsed successfully');
      } catch (parseErr) {
        console.error('[Meter Check] parse error:', parseErr.message);
        console.error('[Meter Check] raw response:', meterResponse.substring(0, 500));
        meterValidation = [{ field: 'Meter Check', value: 'Error', valid: false, reason: 'Failed to parse meter validation response' }];
        console.log('[Meter Check] Using fallback error array:', meterValidation);
      }
    }

    // Save meter validation to Firebase
    const contractId = contractNumber.replace(/\//g, '_');
    if (meterValidation) {
      await db.collection('web_scrape_results').doc(contractId).set({
        meter_validation_result: meterValidation,
        utility_raw: utilityRaw,
        meter_check_timestamp: new Date()
      }, { merge: true });
      
      console.log('[Meter Check] Results saved to Firebase');
    }

    console.log('[Meter Check] Final meterValidation before response:', meterValidation);
    console.log('[Meter Check] meterValidation type:', typeof meterValidation);
    console.log('[Meter Check] meterValidation isArray:', Array.isArray(meterValidation));

    res.json({
      success: true,
      meterValidation: meterValidation,
      message: 'Meter check completed successfully'
    });

  } catch (err) {
    console.error('[Meter Check] Error:', err);
    res.status(500).json({
      success: false,
      message: 'Meter check failed',
      error: err.message
    });
  }
});

app.post('/api/scrape-url-test', async (req, res) => {
  const { systemType, username, password, contractNumber } = req.body;
  // fallback if promptKey is missing or empty
  const promptKey = (req.body.promptKey && req.body.promptKey.trim())
    ? req.body.promptKey.trim()
    : 'LOI_permanent_fixed_fields';

  if (!systemType || systemType === 'others') {
    return res.status(400).json({ success: false, message: 'Invalid systemType' });
  }
  if (!username || !password || !contractNumber) {
    return res.status(400).json({ success: false, message: 'username, password & contractNumber required' });
  }

  try {
    // --- LOGIN STEP ---
    let browser, page;
    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
    } else {
      browser = await puppeteer.launch({ headless: false });
      page = await browser.newPage();
      page.setDefaultTimeout(0); // Disable all timeouts
      page.setDefaultNavigationTimeout(0); // Disable navigation timeouts
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });

      await page.waitForSelector('#lblToLoginPage', { timeout: 20000 });
      await page.click('#lblToLoginPage');

      await page.waitForSelector('input#username', { timeout: 20000 });
      await page.type('input#username', username, { delay: 50 });
      const continueSel1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      await page.waitForSelector(continueSel1, { timeout: 20000 });
      await page.click(continueSel1);

      await page.waitForSelector('input#password', { timeout: 20000 });
      await page.type('input#password', password, { delay: 50 });
      const continueSel2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      await page.waitForSelector(continueSel2, { timeout: 20000 });
      await page.click(continueSel2);

      await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
      await new Promise(r => setTimeout(r, 10000));

      const html = await page.content();
      if (html.includes('Invalid login')) {
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }
      browserSessions.set(systemType, { browser, page });
    }

    // --- SCRAPE STEP ---
    await page.waitForSelector('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a', { timeout: 10000 });
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      const leaseMenu = [...document.querySelectorAll('a')].find(el => el.textContent.trim() === 'Lease');
      leaseMenu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const isOffer = contractNumber.includes('LO');
    const submenuText = isOffer ? 'Lease Offer' : 'Lease Renewal';
    const submenuClicked = await page.evaluate(text => {
      const links = [...document.querySelectorAll('a')];
      const target = links.find(el => el.textContent.trim() === text);
      if (target) { target.click(); return true; }
      return false;
    }, submenuText);
    if (!submenuClicked) throw new Error(`❌ Could not click ${submenuText}`);
    await new Promise(r => setTimeout(r, 10000));

    await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 70000 });
    const iframeHandle = await page.$('iframe[name="frameBottom"]');
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('❌ Could not access iframe content');

    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 70000 });
    await frame.evaluate(cn => {
      const input = document.querySelector('#panel_SimpleSearch_c1');
      input.value = cn;
      input.focus();
    }, contractNumber);

    await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true, timeout: 10000 });
    await frame.evaluate(() => document.querySelector('a#panel_buttonSearch_bt')?.click());
    await new Promise(r => setTimeout(r, 15000));

    const viewButton = await frame.$('input[src*="view-black-16.png"]');
    if (!viewButton) throw new Error('❌ View icon not found');
    await viewButton.click();

    const popupUrlMatch = isOffer ? 'leaseoffer/edit.aspx' : 'leaserenewal/edit.aspx';
    let popup;
    for (let i = 0; i < 15; i++) {
      const pages = await browser.pages();
      popup = pages.find(p => p.url().includes(popupUrlMatch) && p !== page);
      if (popup) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!popup) throw new Error('❌ Popup window not found');
    await popup.bringToFront();

    const panels = [
      '#panelMonthlyCharge_label',
      '#panelOtherMonthlyCharge_label',
      '#panelGTO_label',
      '#LeaseMeterTypessArea_label',
      '#panelSecurityDeposit_label',
      '#panelOneTimeCharge_label'
    ];
    await new Promise(r => setTimeout(r, 10000));
    for (const sel of panels) {
      try {
        const collapsed = await popup.$eval(sel, el => el.classList.contains('collapsible-panel-collapsed'));
        if (collapsed) await popup.click(sel);
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }

    const raw = await popup.evaluate(() => document.body.innerText);
    const promptFile = path.join(__dirname, 'prompts', `${promptKey}.txt`);
    if (!fs.existsSync(promptFile)) throw new Error(`Prompt ${promptKey} not found`);
    const template = fs.readFileSync(promptFile, 'utf8');
    const gemRes = await model.generateContent(`${template}\n\nContent:\n${raw}`);
    const gemText = await gemRes.response.text();

    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      timestamp: new Date(),
      contract_number: docId,
      web_extracted: raw,
      gemini_output: gemText,
      popup_url: popup.url()
    }, { merge: true });

    return res.json({ success: true, raw, geminiOutput: gemText, popupUrl: popup.url() });
  } catch (err) {
    console.error('[SCRAPE-URL-TEST Error]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

async function refreshAllVerifiedStatus() {
  console.log('[⟳] Starting to recompute verified_status for all compare_result documents…');

  try {
    // 1) Grab every document in the "compare_result" collection
    const snapshot = await db.collection('compare_result').get();

    if (snapshot.empty) {
      console.log('[⟳] No documents found in compare_result; nothing to update.');
      return;
    }

    // 2) Loop through each doc, compute “Passed” vs “Needs Review”, then write
    const batch = db.batch(); // use a batch write in case you have many docs

    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data();
      const docRef = docSnap.ref;
      const docId = docSnap.id; // e.g. "ABC123"

      // a) Pull out compare_result array and validation_result array
      //    * You can also include web_validation_result if desired, but up to you.
      const compareArr = Array.isArray(data.compare_result) ? data.compare_result : [];
      const pdfValArr = Array.isArray(data.validation_result) ? data.validation_result : [];
      const webValArr = Array.isArray(data.web_validation_result)
        ? data.web_validation_result
        : [];

      // b) Compute “all match = true?” and “all valid = true?”
      const allCompareMatch = compareArr.length > 0 && compareArr.every((row) => row.match === true);
      const allPdfValid = pdfValArr.length > 0 && pdfValArr.every((row) => row.valid === true);
      const allWebValid = webValArr.length > 0 && webValArr.every((row) => row.valid === true);

      // c) Decide final “verified” status rule:
      //    Here we’ll say “Passed” only if all three arrays exist AND every row is true.
      //    If any array is missing or any row fails, we call it “Needs Review.”
      let finalStatus = 'Needs Review';
      if (allCompareMatch && allPdfValid && allWebValid) {
        finalStatus = 'Passed';
      }

      // d) Schedule a merge‐write updating “verified_status”
      batch.set(docRef, { verified_status: finalStatus }, { merge: true });
      console.log(`   • Doc ${docId}: compare(${allCompareMatch}), pdf(${allPdfValid}), web(${allWebValid}) → "${finalStatus}"`);
    });

    // 3) Commit in one batch (or split into multiple if > 500 writes)
    await batch.commit();
    console.log('[✅] All verified_status fields updated successfully.');
  } catch (err) {
    console.error('[❌] Error in refreshAllVerifiedStatus():', err);
  }
}

// ===== Server Start =====
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
