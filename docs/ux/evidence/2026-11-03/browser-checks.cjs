const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('fs');
fs.mkdirSync('/tmp/chief-ui-research', {recursive:true});
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: {width:1280,height:900} });
  const page = await context.newPage();
  const errors=[], requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});
  page.on('requestfailed',r=>errors.push(r.url()+': '+r.failure()?.errorText));
  page.on('request',r=>requests.push(r.url()));
  const routes=['/','/meetings','/meetings/history','/meetings/weekly','/transcripts','/content','/content-scout','/content-research','/research','/youtube','/terminal','/terminal/people','/terminal/companies','/tasks','/settings','/onboarding','/runs'];
  const problems=[];
  for(const width of [320,375,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    for(const route of routes) {
      await page.goto('http://127.0.0.1:5417'+route);
      await page.waitForTimeout(800);
      const size=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
      if(size.scroll>width) problems.push({route,width,...size});
      if(width===375 || width===1440) {
        const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
        for(const v of results.violations)problems.push({route,width,id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))});
      }
    }
  }
  console.log(JSON.stringify({phase:'layout_and_axe',problems,errors},null,2));
  fs.writeFileSync('/tmp/chief-ui-research/browser-layout-results.json',JSON.stringify({problems,errors},null,2));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:5417');
  await page.waitForTimeout(1200);
  await page.screenshot({path:'/tmp/chief-ui-research/after-desktop.png',fullPage:true});
  await page.setViewportSize({width:375,height:812});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:5417');
  await page.getByRole('heading',{name:'What’s on your mind?',exact:true}).waitFor();
  await page.screenshot({path:'/tmp/chief-ui-research/after-mobile.png',fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.reload();
  const animations=await page.evaluate(()=>document.getAnimations().map(a=>a.animationName));
  assert.deepEqual(animations,[],'Reduced motion must disable all animation');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Skip to content');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'main');
  await page.getByRole('link',{name:'Start with one task'}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'capture-a-task');
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('UI probe ✨ <small steps>');
  await page.getByRole('button',{name:'Add task',exact:true}).click();
  await page.getByRole('heading',{name:'UI probe ✨ <small steps>',exact:true}).waitFor();
  await page.locator('.cds-guide summary').click();
  assert(await page.locator('.cds-guide').evaluate(e=>e.open));
  await page.goto('http://127.0.0.1:5417/settings');
  await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Milo <script> ✨ '+ 'a'.repeat(150));
  await page.getByRole('button',{name:'Save preferences',exact:true}).click();
  await page.goto('http://127.0.0.1:5417');
  assert.equal(await page.locator('script').count(),0);
  assert(await page.locator('.cds-welcome').textContent().then(t=>t.includes('Milo <script>')));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),375);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.reload();
  await page.waitForTimeout(4500);
  assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0,'Decorations settle in under five seconds');
  await page.emulateMedia({forcedColors:'active'});
  assert.notEqual(await page.getByRole('link',{name:'Start with one task'}).evaluate(e=>getComputedStyle(e).borderStyle),'none');
  console.log(JSON.stringify({routes:routes.length,layoutChecks:routes.length*5,axeChecks:routes.length*2,problems,errors,externalRequests:requests.filter(u=>!u.startsWith('http://127.0.0.1:5417')),reducedMotion:'pass',finiteMotion:'pass',keyboardSkip:'pass',taskCapture:'pass',guide:'pass',escapedLongName:'pass',forcedColors:'pass'},null,2));
  fs.writeFileSync('/tmp/chief-ui-research/browser-results.json',JSON.stringify({problems,errors},null,2));
  await browser.close();
  if(problems.length || errors.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
