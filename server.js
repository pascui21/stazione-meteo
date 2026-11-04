import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function parseCoord(value) {
  if (typeof value !== 'string') return Number(value);
  const match = value.match(/^(-?\d+(\.\d+)?)([NSEW])?$/);
  if (!match) return parseFloat(value);
  let num = parseFloat(match[1]);
  if (match[3] === 'S' || match[3] === 'W') num = -Math.abs(num);
  return num;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, retries = 2, delayMs = 600) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await wait(delayMs);
  }
  throw lastError;
}

async function resolvePlace(cityName) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const url = `https://www.meteosource.com/api/v1/free/find_places?text=${encodeURIComponent(cityName)}&key=${apiKey}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meteosource find_places error ${response.status}: ${body}`);
  }
  const places = await response.json();
  if (!places.length) throw new Error(`Nessuna localita trovata per ${cityName}`);
  return places[0];
}

async function resolveNearestPlace(lat, lon) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const url = `https://www.meteosource.com/api/v1/free/nearest_place?lat=${lat}&lon=${lon}&key=${apiKey}`;
  try {
    const response = await fetchWithRetry(url);
    if (!response.ok) return null;
    const place = await response.json();
    return Array.isArray(place) ? place[0] : place;
  } catch (err) {
    return null;
  }
}

async function fetchPoint(options) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const locationQuery = options.placeId ? `place_id=${options.placeId}` : `lat=${options.lat}&lon=${options.lon}`;
  const url = `https://www.meteosource.com/api/v1/free/point?${locationQuery}&sections=current,hourly,daily&units=metric&key=${apiKey}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meteosource point error ${response.status}: ${body}`);
  }
  return await response.json();
}

function buildWeatherSummary(name, lat, lon, data) {
  const current = data.current || {};
  const hourlyData = (data.hourly && data.hourly.data) ? data.hourly.data : [];
  const hourly = hourlyData.slice(0, 8).map(h => ({
    time: h.date,
    temperature: h.temperature,
    summary: h.weather
  }));
  const dailyData = (data.daily && data.daily.data) ? data.daily.data : [];
  const daily = dailyData.slice(0, 5).map(d => ({
    day: d.day,
    summary: d.weather,
    min: d.all_day ? d.all_day.temperature_min : null,
    max: d.all_day ? d.all_day.temperature_max : null,
    sunrise: (d.astro && d.astro.sun) ? d.astro.sun.rise : null,
    sunset: (d.astro && d.astro.sun) ? d.astro.sun.set : null
  }));

  return {
    name: name,
    lat: lat,
    lon: lon,
    current: {
      temperature: current.temperature != null ? current.temperature : null,
      feelsLike: current.feels_like != null ? current.feels_like : null,
      summary: current.summary || null,
      humidity: current.humidity != null ? current.humidity : null,
      windSpeed: current.wind ? current.wind.speed : null,
      windDir: current.wind ? current.wind.dir : null,
      pressure: current.pressure != null ? current.pressure : null,
      uvIndex: current.uv_index != null ? current.uv_index : null
    },
    hourly: hourly,
    daily: daily
  };
}

async function getWeatherByCity(cityName) {
  const place = await resolvePlace(cityName);
  const data = await fetchPoint({ placeId: place.place_id });
  return buildWeatherSummary(capitalize(cityName), parseCoord(place.lat), parseCoord(place.lon), data);
}

async function getWeatherByCoords(lat, lon) {
  const data = await fetchPoint({ lat: lat, lon: lon });
  const nearest = await resolveNearestPlace(lat, lon);
  const name = (nearest && nearest.name) ? nearest.name : (lat.toFixed(2) + ', ' + lon.toFixed(2));
  return buildWeatherSummary(name, lat, lon, data);
}

app.get('/api/weather', async (req, res) => {
  try {
    const place = req.query.place;
    const lat = req.query.lat;
    const lon = req.query.lon;
    let weather;
    if (place) {
      weather = await getWeatherByCity(place);
    } else if (lat && lon) {
      weather = await getWeatherByCoords(parseFloat(lat), parseFloat(lon));
    } else {
      return res.status(400).json({ error: 'Specifica place oppure lat e lon.' });
    }
    res.json(weather);
  } catch (error) {
    console.error('Errore /api/weather:', error.message);
    res.status(502).json({ error: 'Impossibile recuperare i dati meteo per questa localita.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  try {
    const tools = [{
      type: "function",
      function: {
        name: "get_weather_forecast",
        description: "Ottiene le previsioni meteo attuali e future per una specifica citta o localita.",
        parameters: {
          type: "object",
          properties: {
            place_id: { type: "string", description: "Il nome della citta scritto interamente in minuscolo (es. milano, torino, roma, napoli)" }
          },
          required: ["place_id"]
        }
      }
    }];

    const messages = [
      { role: 'system', content: 'Rispondi sempre in italiano, anche se i dati meteo ricevuti sono in inglese.' },
      { role: 'user', content: message }
    ];

    let chatCompletion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: messages,
      tools: tools,
      tool_choice: "auto"
    });

    const responseMessage = chatCompletion.choices[0].message;
    let widgetWeather = null;

    if (responseMessage.tool_calls) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.function.name === "get_weather_forecast") {
          const args = JSON.parse(toolCall.function.arguments);

          try {
            const weather = await getWeatherByCity(args.place_id);
            widgetWeather = weather;

            messages.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "get_weather_forecast",
              content: JSON.stringify(weather)
            });
          } catch (apiError) {
            console.error("Errore Meteosource:", apiError.message);
            messages.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "get_weather_forecast",
              content: JSON.stringify({ error: "Impossibile recuperare i dati meteo per questa localita." })
            });
          }
        }
      }

      const secondCompletion = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: messages
      });

      return res.json({ reply: secondCompletion.choices[0].message.content, weather: widgetWeather });
    }

    res.json({ reply: responseMessage.content, weather: null });

  } catch (error) {
    console.error("Errore generato dal server:", error);
    res.status(500).json({ error: 'Errore interno durante elaborazione della richiesta con Groq.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server della stazione meteo attivo sulla porta ${PORT}`));
