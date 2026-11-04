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

// Il piano Free di Meteosource supporta solo language=en
async function resolvePlace(cityName) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const url = `https://www.meteosource.com/api/v1/free/find_places?text=${encodeURIComponent(cityName)}&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meteosource find_places error ${response.status}: ${body}`);
  }
  const places = await response.json();
  if (!places.length) throw new Error(`Nessuna localita trovata per ${cityName}`);
  return places[0];
}

async function fetchMeteosourceForecast(cityName) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const place = await resolvePlace(cityName);
  const url = `https://www.meteosource.com/api/v1/free/point?place_id=${place.place_id}&sections=current,hourly&units=metric&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meteosource point error ${response.status}: ${body}`);
  }
  const data = await response.json();
  return { place, data };
}

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
            const { place, data } = await fetchMeteosourceForecast(args.place_id);

            widgetWeather = {
              name: capitalize(args.place_id),
              lat: parseCoord(place.lat),
              lon: parseCoord(place.lon),
              temperature: data.current ? data.current.temperature : null,
              summary: data.current ? data.current.summary : null
            };

            messages.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "get_weather_forecast",
              content: JSON.stringify(data)
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
