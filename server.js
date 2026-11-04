import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';

const app = express();
app.use(cors());
app.use(express.json());

// Inizializza l'interfaccia Groq usando la chiave d'ambiente caricata su Render
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Funzione interna per chiamare l'API REST di Meteosource in modo sicuro
async function fetchMeteosourceForecast(placeId) {
  const apiKey = process.env.METEOSOURCE_API_KEY;
  const url = `https://meteosource.com{placeId}&sections=current,forecasts&language=it&units=metric&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Meteosource API error: ${response.statusText}`);
  return await response.json();
}

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  try {
    // 1. Specifica la funzione (Tool) che il modello Groq può decidere di chiamare
    const tools = [{
      type: "function",
      function: {
        name: "get_weather_forecast",
        description: "Ottiene le previsioni meteo attuali e future per una specifica città o località.",
        parameters: {
          type: "object",
          properties: {
            place_id: { type: "string", description: "Il nome della città scritto interamente in minuscolo (es. milano, torino, roma, napoli)" }
          },
          required: ["place_id"]
        }
      }
    }];

    const messages = [{ role: 'user', content: message }];

    // 2. Chiamata iniziale a Groq per analizzare l'intento dell'utente
    let chatCompletion = await groq.chat.completions.create({
      model: "llama-3.3-70b-specdec",
      messages: messages,
      tools: tools,
      tool_choice: "auto"
    });

    const responseMessage = chatCompletion.choices[0].message;

    // 3. Se l'IA ha rilevato la necessità di usare la funzione meteo
    if (responseMessage.tool_calls) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.function.name === "get_weather_forecast") {
          const args = JSON.parse(toolCall.function.arguments);
          
          try {
            // Esegue la chiamata all'API di Meteosource usando la chiave protetta
            const weatherData = await fetchMeteosourceForecast(args.place_id);

            // Restituisce i dati strutturati a Groq
            messages.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "get_weather_forecast",
              content: JSON.stringify(weatherData)
            });
          } catch (apiError) {
            messages.push({
              tool_call_id: toolCall.id,
              role: "tool",
              name: "get_weather_forecast",
              content: JSON.stringify({ error: "Impossibile recuperare i dati meteo per questa località." })
            });
          }
        }
      }

      // 4. Seconda chiamata a Groq per generare la risposta finale testuale in italiano
      const secondCompletion = await groq.chat.completions.create({
        model: "llama-3.3-70b-specdec",
        messages: messages
      });

      return res.json({ reply: secondCompletion.choices[0].message.content });
    }

    // Se l'utente ha fatto una domanda generica che non richiede dati meteo
    res.json({ reply: responseMessage.content });

  } catch (error) {
    console.error("Errore generato dal server:", error);
    res.status(500).json({ error: 'Errore interno durante l\'elaborazione della richiesta con Groq.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server della stazione meteo attivo sulla porta ${PORT}`));
