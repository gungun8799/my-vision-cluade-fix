import puppeteer from 'puppeteer';

async function testMeterFlow() {
  console.log('[TEST] Starting meter flow test...');
  
  let browser;
  try {
    // Launch browser
    browser = await puppeteer.launch({ 
      headless: false,
      defaultViewport: null,
      args: ['--start-maximized']
    });
    
    const page = await browser.newPage();
    
    // Navigate to the correct URL
    console.log('[TEST] Navigating to Simplicity...');
    await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle0' });
    
    // Perform login
    console.log('[TEST] Performing login...');
    try {
      // Click "Click to go to the login page" + wait for it to load
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
      await Promise.all([
        page.click('#lblToLoginPage'),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);
      console.log('[TEST] Clicked login page link');

      // Enter username and Continue
      await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });
      console.log('[TEST] Entered username');

      const continueSel1 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
      await page.click(continueSel1);
      console.log('[TEST] Clicked continue after username');

      // Enter password and Continue
      await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
      await page.type('input#password', 'Gofresh@0725-19', { delay: 50 });
      console.log('[TEST] Entered password');

      const continueSel2 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      await page.waitForSelector(continueSel2, { visible: true, timeout: 20000 });
      await Promise.all([
        page.click(continueSel2),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
      ]);
      console.log('[TEST] Clicked continue after password');

      // small extra buffer
      await new Promise(r => setTimeout(r, 10000));

      // Verify login succeeded
      const html = await page.content();
      if (html.includes('Invalid login')) {
        throw new Error('Invalid credentials');
      }
      
      console.log('[TEST] Login successful');
    } catch (loginError) {
      console.log('[TEST] Auto-login failed:', loginError.message);
      console.log('[TEST] Please login manually');
      console.log('[TEST] Press Enter when logged in and ready to continue...');
      await new Promise(resolve => {
        process.stdin.once('data', resolve);
      });
    }
    
    // Now test the meter flow directly after login
    console.log('[TEST] Starting meter navigation flow...');
    const contractNumber = '5009_LO2505_00075';
    
    // Wait a bit after login to ensure page is fully loaded
    await new Promise(r => setTimeout(r, 5000));
    
    // Navigate to meter page
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    console.log('[Meter Check] scrolled down');
    await new Promise(r => setTimeout(r, 2000));

    // Check if Utilities menu exists
    const utilMenuCheck = await page.evaluate(() => {
      const utilSel = '#menu_MenuLiteralDiv > ul > li:nth-child(22) > a > div.cssmenu-item-label';
      const element = document.querySelector(utilSel);
      console.log('Utilities menu element:', element);
      console.log('Utilities menu text:', element?.textContent);
      console.log('Utilities menu visible:', element?.offsetParent !== null);
      return {
        exists: !!element,
        text: element?.textContent || 'not found',
        visible: element?.offsetParent !== null
      };
    });
    console.log('[TEST] Utilities menu check:', utilMenuCheck);

    // Try to find the exact menu item
    const menuStructure = await page.evaluate(() => {
      const menuItems = document.querySelectorAll('#menu_MenuLiteralDiv > ul > li');
      const items = [];
      menuItems.forEach((item, index) => {
        const label = item.querySelector('.cssmenu-item-label');
        items.push({
          index: index + 1,
          text: label?.textContent?.trim() || 'no text',
          hasSubmenu: !!item.querySelector('ul')
        });
      });
      return items;
    });
    console.log('[TEST] Menu structure:', menuStructure);

    // Click Utilities top-menu
    const utilSel = '#menu_MenuLiteralDiv > ul > li:nth-child(22) > a > div.cssmenu-item-label';
    console.log('[Meter Check] clicking Utilities top-menu');
    
    try {
      await page.waitForSelector(utilSel, { visible: true, timeout: 20000 });
      await page.click(utilSel);
      console.log('[TEST] Successfully clicked Utilities menu');
    } catch (error) {
      console.error('[TEST] Failed to click Utilities menu:', error.message);
      
      // Try alternative approach
      console.log('[TEST] Trying alternative click method...');
      const clicked = await page.evaluate(() => {
        const utilSel = '#menu_MenuLiteralDiv > ul > li:nth-child(22) > a > div.cssmenu-item-label';
        const element = document.querySelector(utilSel);
        if (element) {
          element.click();
          return true;
        }
        return false;
      });
      console.log('[TEST] Alternative click result:', clicked);
    }

    // Hover to expand submenu
    console.log('[Meter Check] hovering Utilities submenu');
    await page.evaluate(() => {
      const li = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(22)');
      if (li) {
        li.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        console.log('[Page] Dispatched mouseover on utilities menu');
      } else {
        console.log('[Page] Could not find utilities menu li element');
      }
    });
    await new Promise(r => setTimeout(r, 10000));

    // Check submenu structure
    const submenuCheck = await page.evaluate(() => {
      const submenu = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(22) ul');
      const submenu25 = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(25) ul');
      
      const getSubmenuItems = (menu) => {
        if (!menu) return [];
        return Array.from(menu.querySelectorAll('a')).map(a => a.textContent.trim());
      };
      
      return {
        submenu22: {
          exists: !!submenu,
          items: getSubmenuItems(submenu)
        },
        submenu25: {
          exists: !!submenu25,
          items: getSubmenuItems(submenu25)
        }
      };
    });
    console.log('[TEST] Submenu check:', JSON.stringify(submenuCheck, null, 2));

    // Click "Meter" submenu
    console.log('[Meter Check] clicking Meter submenu');
    const clickedMeter = await page.evaluate(() => {
      const menu = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(25) ul');
      console.log('[Page] Menu at li:nth-child(25):', menu);
      if (!menu) {
        // Try to find in the submenu of item 22
        const altMenu = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(22) ul');
        console.log('[Page] Alternative menu at li:nth-child(22):', altMenu);
        if (altMenu) {
          const links = Array.from(altMenu.querySelectorAll('a'));
          console.log('[Page] Links found:', links.map(a => a.textContent.trim()));
          const meterLink = links.find(x => x.textContent.trim() === 'Meter');
          if (meterLink) {
            meterLink.click();
            return true;
          }
        }
        return false;
      }
      const a = Array.from(menu.querySelectorAll('a'))
        .find(x => x.textContent.trim() === 'Meter');
      if (a) { a.click(); return true; }
      return false;
    });
    console.log('[TEST] Clicked meter result:', clickedMeter);

    // Wait a bit to see results
    await new Promise(r => setTimeout(r, 5000));
    
    console.log('[TEST] Test completed. Check the browser window.');
    
  } catch (error) {
    console.error('[TEST] Error during test:', error);
  } finally {
    console.log('[TEST] Press Enter to close browser...');
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
    if (browser) {
      await browser.close();
    }
  }
}

// Run the test
testMeterFlow();