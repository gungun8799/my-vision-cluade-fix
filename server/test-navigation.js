import puppeteer from 'puppeteer';

async function testNavigationLogic() {
  console.log('[TEST] Starting navigation logic test...');
  
  let browser, page;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({ 
      headless: false,
      defaultViewport: null,
      args: ['--start-fullscreen']
    });
    page = await browser.newPage();
    page.setDefaultTimeout(0); // Disable all timeouts
    page.setDefaultNavigationTimeout(0); // Disable navigation timeouts
    
    console.log('[TEST] Browser launched, navigating to Simplicity...');
    
    // Navigate to Simplicity
    await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { 
      waitUntil: 'networkidle2' 
    });
    
    // Login steps (assuming you need to login first)
    console.log('[TEST] Waiting for login page...');
    await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
    await page.click('#lblToLoginPage');
    
    console.log('[TEST] Entering username...');
    await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
    await page.type('input#username', 'fin_cpxis_lotuss', { delay: 50 });
    
    const continueSel1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
    await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
    await page.click(continueSel1);
    
    console.log('[TEST] Entering password...');
    await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
    await page.type('input#password', 'CPXISLotuss@2024', { delay: 50 });
    
    const continueSel2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
    await page.waitForSelector(continueSel2, { visible: true, timeout: 20000 });
    await page.click(continueSel2);
    
    console.log('[TEST] Waiting for main page...');
    await page.waitForSelector('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a', { timeout: 20000 });
    
    console.log('[TEST] Clicking Lease Renewal...');
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    
    console.log('[TEST] Waiting for iframe...');
    await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 70000 });
    const iframeHandle = await page.$('iframe[name="frameBottom"]');
    const frame = await iframeHandle.contentFrame();
    
    if (!frame) {
      throw new Error('Could not access iframe content');
    }
    
    console.log('[TEST] Iframe accessed, waiting for search field...');
    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 70000 });
    
    console.log('[TEST] Typing contract number: 5114_LR2505_00107');
    await frame.evaluate((contract) => {
      const input = document.querySelector('#panel_SimpleSearch_c1');
      if (input) {
        input.value = contract;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, '5114_LR2505_00107');
    
    console.log('[TEST] Clicking search button...');
    await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true, timeout: 10000 });
    await frame.evaluate(() => {
      const btn = document.querySelector('a#panel_buttonSearch_bt');
      if (btn) btn.click();
    });
    
    console.log('[TEST] Waiting 15 seconds for search results...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    console.log('[TEST] Looking for view icon...');
    const viewButton = await frame.$('input[src*="view-black-16.png"]');
    if (!viewButton) {
      console.error('[TEST] ❌ View icon not found');
      throw new Error('View icon not found');
    }
    
    console.log('[TEST] ✅ View icon found, clicking...');
    await viewButton.click();
    
    console.log('[TEST] View icon clicked successfully!');
    
    const popupUrlMatch = 'leaserenewal/edit.aspx';
    
    console.log('[TEST] Cleaning up old popups...');
    const oldPages = await browser.pages();
    for (const p of oldPages) {
      const url = p.url();
      if (url.includes('leaseoffer/edit.aspx') || url.includes('leaserenewal/edit.aspx')) {
        if (p !== page) {
          console.log('[TEST] Closing old popup:', url);
          await p.close();
        }
      }
    }
    
    console.log('[TEST] Waiting for new popup window...');
    let popup;
    for (let i = 0; i < 30; i++) { // Increased from 15 to 30 iterations
      console.log(`[TEST] Popup search attempt ${i + 1}/30`);
      const pages = await browser.pages();
      console.log('[TEST] Current pages:', pages.map(p => p.url()));
      popup = pages.find(p => p.url().includes(popupUrlMatch) && p !== page);
      if (popup) {
        console.log('[TEST] ✅ Popup found:', popup.url());
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    if (!popup) {
      console.error('[TEST] ❌ Popup window not found for:', popupUrlMatch);
      console.log('[TEST] All current pages:');
      const allPages = await browser.pages();
      allPages.forEach((p, i) => console.log(`  ${i}: ${p.url()}`));
      throw new Error('Popup window not found');
    }
    
    console.log('[TEST] ✅ Popup window found, bringing to front...');
    await popup.bringToFront();
    
    console.log('[TEST] Waiting for popup content to load...');
    await popup.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 0 });
    
    console.log('[TEST] Popup content loaded, getting text...');
    const scrapedText = await popup.evaluate(() => document.body.innerText);
    console.log('[TEST] ✅ Scraped content length:', scrapedText.length);
    console.log('[TEST] ✅ First 500 characters:', scrapedText.substring(0, 500));
    
    console.log('[TEST] ✅ Navigation logic test SUCCESSFUL!');
    
  } catch (error) {
    console.error('[TEST] ❌ Navigation logic test FAILED:', error.message);
    console.error('[TEST] Error stack:', error.stack);
  } finally {
    if (browser) {
      console.log('[TEST] Closing browser...');
      await browser.close();
    }
  }
}

// Run the test
testNavigationLogic().then(() => {
  console.log('[TEST] Test completed.');
}).catch((err) => {
  console.error('[TEST] Test crashed:', err);
});