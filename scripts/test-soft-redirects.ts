async function testUrl(url: string, expectedTitle: string) {
  console.log(`\n=== Testing: ${url} ===`);
  console.log(`Expected content about: ${expectedTitle}`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0)' },
      redirect: 'follow',
    });

    console.log(`Status: ${response.status}`);
    console.log(`Final URL: ${response.url}`);
    
    // Check if redirected to generic page
    const originalPath = new URL(url).pathname;
    const finalPath = new URL(response.url).pathname;
    
    console.log(`Original path: ${originalPath}`);
    console.log(`Final path: ${finalPath}`);
    
    // Check if path got reduced to root or generic listing
    const genericPaths = ['/', '/blog', '/blog/', '/reports', '/reports/', '/press-news', '/esma-news'];
    const isGenericPath = genericPaths.some(p => finalPath === p || finalPath.endsWith('/esma-news') || finalPath.endsWith('/blog'));
    
    if (finalPath !== originalPath) {
      console.log(`⚠️  REDIRECTED: ${originalPath} → ${finalPath}`);
    }
    if (isGenericPath && originalPath !== finalPath) {
      console.log(`❌ SOFT REDIRECT TO GENERIC PAGE`);
    }

    // Get page title
    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : 'No title found';
    console.log(`Page title: ${pageTitle}`);

    // Check for "not found" indicators in content
    const notFoundIndicators = [
      'not found', 'page not found', '404', 'report not found',
      'no results', 'cannot be found', 'does not exist'
    ];
    const lowerHtml = html.toLowerCase();
    for (const indicator of notFoundIndicators) {
      if (lowerHtml.includes(indicator)) {
        console.log(`⚠️  Page contains "${indicator}" text`);
      }
    }

  } catch (error) {
    console.log(`Error: ${error}`);
  }
}

async function main() {
  // Test Dealroom URLs
  await testUrl(
    'https://dealroom.co/reports/cee-fintech-pre-seed-q2-2026',
    'CEE Fintech Pre-Seed Q2 2026'
  );
  await testUrl(
    'https://dealroom.co/reports/eu-fintech-ma-h1-2026',
    'EU Fintech M&A H1 2026'
  );

  // Test Amplitude URL
  await testUrl(
    'https://amplitude.com/blog/fintech-retention-benchmarks-2026',
    'Fintech Retention Benchmarks 2026'
  );

  // Test a specific ESMA URL (not just homepage)
  await testUrl(
    'https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica',
    'MiCA Regulation'
  );

  // Test confirmed working URLs for comparison
  console.log('\n\n=== CONTROL GROUP (Should be working) ===');
  
  await testUrl(
    'https://owasp.org/www-project-top-ten/',
    'OWASP Top 10'
  );
  
  await testUrl(
    'https://www.circle.com/grant',
    'Circle Grant'
  );
}

main().catch(console.error);
