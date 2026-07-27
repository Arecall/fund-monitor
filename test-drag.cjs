// 联合验证: PC 鼠标 + 触屏
// 1) PC 拖 A(idx=0) 到 idx=2 中点, 鼠标停住, 看是否停在 idx=2
// 2) 触屏拖 D(idx=3) 到顶, 看是否反向

const puppeteer = require('puppeteer-core');

async function testCase({ isMobile, name, fromIdx, toY }) {
  console.log(`\n=== ${name} ===`);
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 1400, deviceScaleFactor: 2, isMobile: !!isMobile, hasTouch: !!isMobile });
    page.on('console', msg => console.log('PAGE:', msg.text()));
    page.on('pageerror', err => console.error('PAGE-ERR:', err.message));

    await page.goto('http://localhost:3001', { waitUntil: 'networkidle0', timeout: 15000 });
    await page.waitForSelector('input[autocomplete="username"]', { timeout: 5000 });
    const newUser = 'tu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    await page.type('input[autocomplete="username"]', newUser);
    await page.type('input[autocomplete="current-password"]', 'test1234');
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('input[placeholder*="代码"]'), { timeout: 8000 });
    await new Promise(r => setTimeout(r, 1000));

    // 添加 4 个基金
    const codes = ['012630', '161039', '003547', '161725'];
    for (const code of codes) {
      await page.click('input[placeholder*="代码"]');
      await page.keyboard.type(code);
      await page.click('button[type="submit"]');
      await new Promise(r => setTimeout(r, 1500));
    }

    // 找到 fromIdx 对应的行
    const visibleRows = await page.evaluateHandle(() => {
      const arr = Array.from(document.querySelectorAll('[data-fund-code]'));
      return arr.filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    });
    const codes_arr = await page.evaluate(arr => arr.map(el => el.getAttribute('data-fund-code')), visibleRows);
    console.log('Initial visible order:', codes_arr);

    const targetRow = (await visibleRows.getProperty(fromIdx)).asElement();
    const startBox = await targetRow.boundingBox();
    const startX = startBox.x + startBox.width / 2;
    const startY = startBox.y + startBox.height / 2;
    console.log('Drag from idx', fromIdx, 'at', startX, startY, '→ y=', toY);

    // 模拟拖动
    await page.evaluate(({ fromIdx, toY, isMobile }) => {
      // 直接拿 fromIdx 位置的 visible row
      const rows = Array.from(document.querySelectorAll('[data-fund-code]'))
        .filter(el => el.getBoundingClientRect().width > 0);
      const row = rows[fromIdx];
      if (!row) { console.error('row not found at idx', fromIdx); return; }
      console.log('row found:', row.getAttribute('data-fund-code'));
      const r = row.getBoundingClientRect();
      const pid = 1;
      const eventType = isMobile ? 'touch' : 'mouse';
      const dispatch = (el, type, x, y) => {
        const ev = isMobile
          ? new PointerEvent(type, { pointerId: pid, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true })
          : new PointerEvent(type, { pointerId: pid, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true, button: 0 });
        el.dispatchEvent(ev);
      };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      console.log('pointerdown at', cx, cy);
      dispatch(row, 'pointerdown', cx, cy);
      // 触发 long-press (450ms 触屏 / 200ms 鼠标)
      setTimeout(() => {
        const steps = 25;
        const stepMs = 16;
        let stepCount = 0;
        for (let i = 1; i <= steps; i++) {
          setTimeout(() => {
            const y = cy + (toY - cy) * i / steps;
            const x = cx;
            dispatch(document, 'pointermove', x, y);
            stepCount++;
            if (i % 5 === 0) {
              const cur = Array.from(document.querySelectorAll('[data-fund-code]'))
                .filter(el => el.getBoundingClientRect().width > 0)
                .map(el => el.getAttribute('data-fund-code'));
              console.log('step', i, 'clientY=', y, 'order=', cur.join(','));
            }
            if (i === steps) {
              console.log('POINTERUP at', x, y);
              setTimeout(() => {
                dispatch(document, 'pointerup', x, y);
                setTimeout(() => {
                  const result = Array.from(document.querySelectorAll('[data-fund-code]'))
                    .filter(el => el.getBoundingClientRect().width > 0)
                    .map(el => el.getAttribute('data-fund-code'));
                  const banner = document.createElement('div');
                  banner.id = 'final-order-banner';
                  banner.textContent = JSON.stringify(result);
                  document.body.appendChild(banner);
                  console.log('FINAL:', result);
                }, 300);
              }, 100);
            }
          }, i * stepMs);
        }
      }, isMobile ? 500 : 250);
    }, { fromIdx, toY, isMobile: !!isMobile });

    // 等拖动 + spring + 提交
    await new Promise(r => setTimeout(r, isMobile ? 5000 : 4000));
    await page.screenshot({ path: `D:\\cc\\jijin\\test-${name.replace(/[^a-z0-9]/gi, '_')}.png` });

    const finalOrder = await page.evaluate(() => {
      const el = document.getElementById('final-order-banner');
      return el ? el.textContent : 'NOT_FOUND';
    });
    console.log('Final order (visible):', finalOrder);
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await browser.close();
  }
}

(async () => {
  // PC: 拖 A(idx=0) 到 idx=2 目标 mid ≈ 270+158*1.5=507? 简化: 让 toY=270 (C 初始 idx=2 mid)
  //   这样算法第一次算 goalIdx=2, chain 推到 idx=2
  await testCase({ isMobile: false, name: 'PC_拖A到中点', fromIdx: 0, toY: 350 });
  // PC: 拖 D(idx=3) 到 idx=0 中点. toY=30 (A idx=0 mid)
  await testCase({ isMobile: false, name: 'PC_拖D到顶', fromIdx: 3, toY: 30 });
  // 触屏: 拖 D(idx=3) 到顶
  await testCase({ isMobile: true, name: 'TOUCH_拖D到顶', fromIdx: 3, toY: 30 });
  // 触屏: 拖 A(idx=0) 到 idx=2 中点
  await testCase({ isMobile: true, name: 'TOUCH_拖A到中点', fromIdx: 0, toY: 350 });
})();
