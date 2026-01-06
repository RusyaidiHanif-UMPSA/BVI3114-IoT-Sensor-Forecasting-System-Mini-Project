function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = getOrCreateSheet(ss, "Sheet1", [
      "Timestamp",
      "Distance (cm)",
      "Temperature (°C)",
      "Humidity (%)",
      "Pressure (hPa)"
    ]);

    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No POST data received");
    }

    let data = JSON.parse(e.postData.contents);
    if (!Array.isArray(data)) data = [data];  // Handle single object or array

    const rows = [];
    data.forEach(item => {
      // Validate and sanitize
      const dist = validateNumber(item.distance, 0, 400);
      const temp = validateNumber(item.temperature, -40, 85);
      const hum = validateNumber(item.humidity, 0, 100);
      const press = validateNumber(item.pressure, 300, 1100);  // Typical hPa range

      if ([dist, temp, hum, press].some(v => isNaN(v))) return;  // Skip invalid row

      rows.push([
        new Date(item.timestamp ? Number(item.timestamp) : Date.now()),
        dist,
        temp,
        hum,
        press
      ]);
    });

    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    }

    return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);

  } catch (err) {
    return ContentService.createTextOutput("ERROR: " + err.message).setMimeType(ContentService.MimeType.TEXT);
  }
}

/*************************************************************
 *  FORECAST GENERATOR (LINEAR REGRESSION BASED)
 *  Justification: Linear Regression is well-suited for trend-based environmental forecasting
 *  (e.g., gradual temperature/pressure changes). Adaptive window improves accuracy on variable data.
 *************************************************************/
function generateForecasts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const INPUT_SHEET = "Sheet1";
  const OUTPUT_SHEET = "Forecasts";
  const HOURS_AHEAD = 24;

  const inputHeaders = [
    "Timestamp",
    "Distance (cm)",
    "Temperature (°C)",
    "Humidity (%)",
    "Pressure (hPa)"
  ];

  const outputHeaders = [
    "Timestamp",
    "Distance Forecast (cm)", "Distance Upper (cm)", "Distance Lower (cm)",
    "Temperature Forecast (°C)", "Temperature Upper (°C)", "Temperature Lower (°C)",
    "Humidity Forecast (%)", "Humidity Upper (%)", "Humidity Lower (%)",
    "Pressure Forecast (hPa)", "Pressure Upper (hPa)", "Pressure Lower (hPa)"
  ];

  const inputSheet = getOrCreateSheet(ss, INPUT_SHEET, inputHeaders);
  const forecastSheet = getOrCreateSheet(ss, OUTPUT_SHEET, outputHeaders);

  const lastRow = inputSheet.getLastRow();
  if (lastRow < 10) {
    SpreadsheetApp.getUi().alert("Not enough data (need at least 10 rows).");
    return;
  }

  const data = inputSheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const timestamps = data.map(r => r[0].getTime() / 3600000);  // Hours for regression

  const sensors = {
    Distance: data.map(r => parseNumber(r[1])),
    Temperature: data.map(r => parseNumber(r[2])),
    Humidity: data.map(r => parseNumber(r[3])),
    Pressure: data.map(r => parseNumber(r[4]))
  };

  const forecasts = {};
  Object.keys(sensors).forEach(key => {
    forecasts[key] = forecastLR(sensors[key], timestamps, HOURS_AHEAD);
  });

  clearSheetContent(forecastSheet, outputHeaders.length);

  const output = [];
  for (let i = 0; i < HOURS_AHEAD; i++) {
    output.push([
      forecasts.Distance[i].timestamp,
      forecasts.Distance[i].value, forecasts.Distance[i].upper, forecasts.Distance[i].lower,
      forecasts.Temperature[i].value, forecasts.Temperature[i].upper, forecasts.Temperature[i].lower,
      forecasts.Humidity[i].value, forecasts.Humidity[i].upper, forecasts.Humidity[i].lower,
      forecasts.Pressure[i].value, forecasts.Pressure[i].upper, forecasts.Pressure[i].lower
    ]);
  }

  forecastSheet.getRange(2, 1, output.length, outputHeaders.length).setValues(output);
  SpreadsheetApp.getUi().alert("Forecast generated successfully.");
}

/*************************************************************
 *  LINEAR REGRESSION FORECAST WITH CONFIDENCE INTERVALS
 *************************************************************/
function forecastLR(values, timestamps, hoursAhead) {
  const valid = values.map((v, i) => ({ value: v, time: timestamps[i] }))
                     .filter(d => !isNaN(d.value));

  const variance = calculateStdDev(valid.map(d => d.value)) ** 2;
  const window = Math.min(Math.max(12, Math.floor(30 / (variance + 1))), valid.length);  // Adaptive 12-30

  const recent = valid.slice(-window);

  const n = recent.length;
  const sumX = recent.reduce((a, b) => a + b.time, 0);
  const sumY = recent.reduce((a, b) => a + b.value, 0);
  const sumXY = recent.reduce((a, b) => a + b.time * b.value, 0);
  const sumX2 = recent.reduce((a, b) => a + b.time ** 2, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX ** 2);
  const intercept = (sumY - slope * sumX) / n;

  const residuals = recent.map(d => d.value - (slope * d.time + intercept));
  const stdDev = calculateStdDev(residuals);

  const lastTime = recent[n - 1].time;
  const lastDate = new Date(recent[n - 1].time * 3600000);

  const results = [];
  for (let i = 1; i <= hoursAhead; i++) {
    const futureTime = lastTime + i;
    const value = slope * futureTime + intercept;
    const conf = 1.96 * stdDev;  // ~95% confidence

    results.push({
      timestamp: new Date(lastDate.getTime() + i * 3600000),
      value: round3(value),
      upper: round3(value + conf),
      lower: round3(value - conf)
    });
  }
  return results;
}

/*************************************************************
 *  GEMINI AI INSIGHTS GENERATOR (UPDATED MODEL & ERROR HANDLING)
 *************************************************************/
function generateAIInsights() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inputSheet = ss.getSheetByName("Sheet1");
  const forecastSheet = ss.getSheetByName("Forecasts");
  const aiSheet = getOrCreateSheet(ss, "AI Insights", [
    "Timestamp", "Real-Time Summary", "Trend Analysis", "Predictive Insights"
  ]);

  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    SpreadsheetApp.getUi().alert("Gemini API key not set. Use menu → Set Gemini API Key.");
    return;
  }

  // Recent data (last 15 rows for better context)
  const lastRow = inputSheet.getLastRow();
  const recentRange = inputSheet.getRange(Math.max(2, lastRow - 14), 1, Math.min(15, lastRow - 1), 5);
  const recentData = recentRange.getValues();
  const recentJson = JSON.stringify(recentData.map(r => ({
    timestamp: r[0].toISOString(),
    distance_cm: r[1],
    temperature_C: r[2],
    humidity_percent: r[3],
    pressure_hPa: r[4]
  })));

  // Forecast horizons
  const forecastData = forecastSheet.getRange(2, 1, 24, 13).getValues();
  const horizons = {
    "1_hour": forecastData[0],
    "6_hours": forecastData[5],
    "24_hours": forecastData[23]
  };
  const forecastJson = JSON.stringify(horizons);

  const prompts = {
    realTime: `Provide a concise summary of current environmental conditions and any anomalies from this recent sensor data: ${recentJson}.`,
    trend: `Analyze trends in this time-series sensor data (temperature, humidity, pressure, distance): ${recentJson}. Mention correlations and patterns.`,
    predictive: `Using these forecasts ${forecastJson} and recent data trends, give enhanced predictive insights (e.g., potential weather implications).`
  };

  const insights = {
    realTime: callGemini(apiKey, prompts.realTime),
    trend: callGemini(apiKey, prompts.trend),
    predictive: callGemini(apiKey, prompts.predictive)
  };

  aiSheet.appendRow([new Date(), insights.realTime, insights.trend, insights.predictive]);
  SpreadsheetApp.getUi().alert("AI Insights generated successfully!");
}

/*************************************************************
 *  CALL GEMINI API (UPDATED MODEL & ROBUST ERROR HANDLING)
 *************************************************************/
function callGemini(apiKey, prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  // Current stable fast model as of Dec 2025

  const payload = {
    contents: [{ parts: [{ text: prompt }] }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code !== 200) {
      return `API HTTP Error ${code}: ${text}`;
    }

    const data = JSON.parse(text);

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }

    if (data.error) {
      return `Gemini Error: ${data.error.message}`;
    }

    return `Unexpected response (no text): ${text.substring(0, 200)}...`;
  } catch (err) {
    return `Request failed: ${err.message}`;
  }
}

/*************************************************************
 *  SET GEMINI API KEY
 *************************************************************/
function setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt("Gemini API Key", "Paste your new Gemini API key here:", ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() === ui.Button.OK) {
    const key = response.getResponseText().trim();
    if (key) {
      PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
      ui.alert("API Key saved securely!");
    }
  }
}

/*************************************************************
 *  HELPERS
 *************************************************************/
function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function clearSheetContent(sheet, columnCount) {
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, columnCount).clearContent();
}

function parseNumber(val) {
  if (val === null || val === undefined || val === "") return NaN;
  return parseFloat(String(val).replace(",", "."));
}

function validateNumber(val, min, max) {
  const num = parseNumber(val);
  return (isNaN(num) || num < min || num > max) ? NaN : num;
}

function calculateStdDev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function round3(num) {
  return isNaN(num) ? num : Math.round(num * 1000) / 1000;
}

/*************************************************************
 *  CUSTOM MENU
 *************************************************************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🌡️ Sensor Tools")
    .addItem("Generate Forecasts", "generateForecasts")
    .addItem("Generate AI Insights", "generateAIInsights")
    .addSeparator()
    .addItem("Set Gemini API Key", "setApiKey")
    .addToUi();
}