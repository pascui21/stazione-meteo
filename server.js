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

// Il piano Free di Meteosource supporta solo language=en
async function resolvePlaceId(cityName) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const url = `https://www.meteosource.com/api/v1/free/find_places?text=${encodeURIComponent(cityName)}&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meteosource find_places error ${response.status}: ${body}`);
  }
  const places = await response.json();
  if (!places.length) throw new Error(`Nessuna localita trovata per ${cityName}`);
  return places[0].place_id;
}

async function fetchMeteosourceForecast(cityName) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const placeId = await resolvePlaceId(cityName);
  const url = `https://www.meteosource.com/api/v1/free/point?place_id=${placeId}&sections=current,hourly&units=metric&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meteosource point error ${response.status}: ${body}`);
  }
  return await response.json();
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

    if (responseMessage.tool_calls) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.function.name === "get_weather_forecast") {
          const args = JSON.parse(toolCall.function.arguments);

          try {
            const weatherData = await fetchMeteosourceForecast(args.place_id);

            messages.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "get_weather_forecast",
              content: JSON.stringify(weatherData)
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

      return res.json({ reply: secondCompletion.choices[0].message.content });
    }

    res.json({ reply: responseMessage.content });

  } catch (error) {
    console.error("Errore generato dal server:", error);
    res.status(500).json({ error: 'Errore interno durante elaborazione della richiesta con Groq.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server della stazione meteo attivo sulla porta ${PORT}`));
