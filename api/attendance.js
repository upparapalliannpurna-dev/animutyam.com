export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }
    const { rollNo, password } = body || {};
    if (!rollNo || !password) {
      return res.status(400).json({ success: false, error: 'Please provide both Roll Number and Password.' });
    }

    const trimmedRoll = String(rollNo).trim();
    const trimmedPwd = String(password).trim();

    // Cookie storage map
    const cookies = new Map();

    function updateCookies(response) {
      let setCookies = [];
      if (typeof response.headers.getSetCookie === 'function') {
        setCookies = response.headers.getSetCookie();
      } else {
        const h = response.headers.get('set-cookie');
        if (h) setCookies = [h];
      }

      for (const str of setCookies) {
        if (!str) continue;
        const parts = str.split(';');
        const pair = parts[0].trim();
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const k = pair.slice(0, eqIdx).trim();
          const v = pair.slice(eqIdx + 1).trim();
          cookies.set(k, v);
        }
      }
    }

    function getCookieHeader() {
      return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    // Custom fetch that manually handles redirects and maintains cookies across 302 redirects
    async function fetchWithCookies(url, options = {}, maxRedirects = 5) {
      let currentUrl = url;
      let currentOptions = { ...options };

      for (let i = 0; i < maxRedirects; i++) {
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...(currentOptions.headers || {})
        };
        const cookieStr = getCookieHeader();
        if (cookieStr) {
          headers['Cookie'] = cookieStr;
        }

        const response = await fetch(currentUrl, {
          ...currentOptions,
          headers,
          redirect: 'manual'
        });

        updateCookies(response);

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const loc = response.headers.get('location');
          if (!loc) return response;
          currentUrl = new URL(loc, currentUrl).href;
          currentOptions = {
            method: 'GET',
            headers: {
              'Referer': currentUrl
            }
          };
          continue;
        }

        return response;
      }
      throw new Error('Too many redirects');
    }

    // Step 1: Initial GET to fetch ASP.NET viewstate & session cookie
    const portalUrl = 'https://webprosindia.com/vignanpharma/Default.aspx';
    const res1 = await fetchWithCookies(portalUrl, { method: 'GET' });
    const html1 = await res1.text();

    const viewStateMatch = html1.match(/id="__VIEWSTATE"\s+value="([^"]+)"/);
    const viewStateGenMatch = html1.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/);
    const eventValidationMatch = html1.match(/id="__EVENTVALIDATION"\s+value="([^"]+)"/);

    if (!viewStateMatch) {
      return res.status(502).json({ success: false, error: 'Could not connect to college portal. Please try again later.' });
    }

    const viewState = viewStateMatch[1];
    const viewStateGen = viewStateGenMatch ? viewStateGenMatch[1] : '';
    const eventValidation = eventValidationMatch ? eventValidationMatch[1] : '';

    // Step 2: POST student login credentials
    const params = new URLSearchParams();
    params.append('__VIEWSTATE', viewState);
    if (viewStateGen) params.append('__VIEWSTATEGENERATOR', viewStateGen);
    if (eventValidation) params.append('__EVENTVALIDATION', eventValidation);
    params.append('txtId2', trimmedRoll);
    params.append('txtPwd2', trimmedPwd);
    params.append('imgBtn2.x', '20');
    params.append('imgBtn2.y', '10');

    const res2 = await fetchWithCookies(portalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': portalUrl
      },
      body: params.toString()
    });

    const html2 = await res2.text();

    // Check for login error in lblError1
    const errMatch = html2.match(/id="lblError1"[^>]*>([^<]+)</);
    if (errMatch && errMatch[1].trim()) {
      return res.status(401).json({ success: false, error: errMatch[1].trim() });
    }

    // Step 3: GET Student Attendance page to initialize session
    const attPageUrl = 'https://webprosindia.com/vignanpharma/Academics/StudentAttendance.aspx?scrid=3&showtype=SA';
    await fetchWithCookies(attPageUrl, {
      method: 'GET',
      headers: { 'Referer': res2.url || portalUrl }
    });

    // Step 4: POST to AjaxPro ShowAttendance method
    const ajaxUrl = 'https://webprosindia.com/vignanpharma/ajax/StudentAttendance,App_Web_studentattendance.aspx.a2a1b31c.ashx?_method=ShowAttendance&_session=r';
    const encRoll = encodeURIComponent(trimmedRoll);
    const postData = `rollNo=${encRoll}\r\nfromDate=\r\ntoDate=\r\nexcludeothersubjects=false`;

    const res4 = await fetchWithCookies(ajaxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Referer': attPageUrl
      },
      body: postData
    });

    const rawHtml = await res4.text();
    if (!rawHtml || rawHtml === 'null') {
      return res.status(404).json({ success: false, error: 'No attendance records found for this student.' });
    }

    // Step 5: Parse HTML response
    let clean = rawHtml.trim();
    if (clean.startsWith('"') && clean.endsWith('"')) {
      clean = clean.slice(1, -1);
    } else if (clean.startsWith("'") && clean.endsWith("'")) {
      clean = clean.slice(1, -1);
    }
    clean = clean.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\r\\n/g, '\n');

    const student = {
      rollNo: trimmedRoll,
      name: '',
      course: '',
      branch: '',
      semester: ''
    };

    const rollM = clean.match(/RollNo<\/td>\s*<td[^>]*>:<\/td>\s*<td[^>]*>(.*?)<\/td>/);
    if (rollM) student.rollNo = rollM[1].trim();

    const nameM = clean.match(/Student Name<\/td>\s*<td[^>]*>:<\/td>\s*<td[^>]*>(.*?)<\/td>/);
    if (nameM) student.name = nameM[1].trim();

    const courseM = clean.match(/Course<\/td>\s*<td[^>]*>:<\/td>\s*<td[^>]*>(.*?)<\/td>/);
    if (courseM) student.course = courseM[1].trim();

    const branchM = clean.match(/Branch<\/td>\s*<td[^>]*>:<\/td>\s*<td[^>]*>(.*?)<\/td>/);
    if (branchM) student.branch = branchM[1].trim();

    const semM = clean.match(/Semester<\/td>\s*<td[^>]*>:<\/td>\s*<td[^>]*>(.*?)<\/td>/);
    if (semM) student.semester = semM[1].trim();

    // Parse subjects table
    const subjects = [];
    const rowRegex = /<tr class='reportData1'>([\s\S]*?)<\/tr>/g;
    let rMatch;
    while ((rMatch = rowRegex.exec(clean)) !== null) {
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      const cells = [];
      let cMatch;
      while ((cMatch = cellRegex.exec(rMatch[1])) !== null) {
        cells.push(cMatch[1].trim());
      }
      if (cells.length >= 5) {
        const held = parseInt(cells[2], 10) || 0;
        const attended = parseInt(cells[3], 10) || 0;
        const percentage = parseFloat(cells[4]) || 0;
        subjects.push({
          sno: cells[0],
          name: cells[1],
          held,
          attended,
          percentage
        });
      }
    }

    // Parse TOTAL row
    const total = {
      held: 0,
      attended: 0,
      missed: 0,
      percentage: 0,
      status: 'Unknown',
      safeBunks: 0,
      neededToReach75: 0
    };

    const totalM = clean.match(/TOTAL<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>([\d\.]+)<\/td>/);
    if (totalM) {
      total.held = parseInt(totalM[1], 10);
      total.attended = parseInt(totalM[2], 10);
      total.missed = Math.max(0, total.held - total.attended);
      total.percentage = parseFloat(totalM[3]);

      if (total.percentage >= 75.0) {
        total.status = 'Eligible';
        const maxTotal = Math.floor(total.attended / 0.75);
        total.safeBunks = Math.max(0, maxTotal - total.held);
      } else {
        total.status = 'Shortage';
        const needed = Math.ceil(3 * total.held - 4 * total.attended);
        total.neededToReach75 = Math.max(0, needed);
      }
    }

    return res.status(200).json({
      success: true,
      student,
      total,
      subjects,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19)
    });

  } catch (error) {
    console.error('Attendance scrape error:', error);
    return res.status(500).json({
      success: false,
      error: 'Server error while fetching attendance: ' + (error.message || 'Unknown error')
    });
  }
}
