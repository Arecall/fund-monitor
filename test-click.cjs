const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 1400, deviceScaleFactor: 2, isMobile: false, hasTouch: false });
  page.on('console', msg => console.log('PAGE:', msg.text()));
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 5000 });
  const user = 'tu_' + Date.now().toString(36);
  await page.type('input[autocomplete="username"]', user);
  await page.type('input[autocomplete="current-password"]', 'test1234');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('input[placeholder*="代码"]'), { timeout: 8000 });
  await new Promise(r => setTimeout(r, 1000));
  await page.click('input[placeholder*="代码"]');
  await page.keyboard.type('012630');
  await page.click('button[type="submit"]');
  await new Promise(r => setTimeout(r, 1500));
  await page.click('input[placeholder*="代码"]');
  await page.keyboard.type('161039');
  await page.click('button[type="submit"]');
  await new Promise(r => setTimeout(r, 2000));

  // 注入 calculateGoalIdx 内部 log
  await page.evaluate(() => {
    // 监听 pointerup
    document.addEventListener('pointerup', () => {
      console.log('--- pointerup fired ---');
    });
  });

  // 获取行
  const visibleRows = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('[data-fund-code]'))
      .filter(el => el.getBoundingClientRect().width > 0);
  });
  const rowCount = await page.evaluate(arr => arr.length, visibleRows);
  console.log('Visible rows:', rowCount);

  // 开始模拟拖拽
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-fund-code]'))
      .filter(el => el.getBoundingClientRect().width > 0);
    const row = rows[0];
    const r = row.getBoundingClientRect();
    console.log('Row 0 rect:', JSON.stringify(r));

    // 模拟 pointerdown
    const pid = 1;
    const evDown = new PointerEvent('pointerdown', { pointerId: pid, pointerType: 'mouse', clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true });
    row.dispatchEvent(evDown);

    // 移动
    setTimeout(() => {
      const cy = r.top + r.height/2;
      const targetY = cy + 180; // 向下移动 3 行左右
      console.log('Moving from', cy, 'to', targetY);

      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        setTimeout(() => {
          const y = cy + (targetY - cy) * i / steps;
          const evMove = new PointerEvent('pointermove', { pointerId: pid, pointerType: 'mouse', clientX: r.left + r.width/2, clientY: y, bubbles: true });
          document.dispatchEvent(evMove);

          if (i === steps) {
            setTimeout(() => {
              const evUp = new PointerEvent('pointerup', { pointerId: pid, pointerType: 'mouse', clientX: r.left + r.width/2, clientY: targetY, bubbles: true });
              document.dispatchEvent(evUp);
            }, 100);
          }
        }, i * 20);
      }
    }, 150);
  });

  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
})();
