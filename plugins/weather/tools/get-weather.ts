import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool } from '../../../src/types';

interface GetWeatherParams {
	city: string;
}

interface WeatherResult {
	city: string;
	country: string;
	temperature: number;
	unit: string;
	condition: string;
	humidity: number;
	windSpeed: number;
	message: string;
}

// Demo weather data
const DEMO_WEATHER: Record<string, { condition: string; tempCelsius: number; humidity: number; windSpeed: number }> = {
	paris: { condition: 'Partiellement nuageux', tempCelsius: 18, humidity: 65, windSpeed: 12 },
	london: { condition: 'Pluvieux', tempCelsius: 14, humidity: 80, windSpeed: 20 },
	'new york': { condition: 'Ensoleille', tempCelsius: 22, humidity: 55, windSpeed: 8 },
	tokyo: { condition: 'Nuageux', tempCelsius: 20, humidity: 70, windSpeed: 10 },
	sydney: { condition: 'Ensoleille', tempCelsius: 25, humidity: 50, windSpeed: 15 },
	default: { condition: 'Variable', tempCelsius: 20, humidity: 60, windSpeed: 10 }
};

const COUNTRY_MAP: Record<string, string> = {
	paris: 'France',
	london: 'Royaume-Uni',
	'new york': 'Etats-Unis',
	tokyo: 'Japon',
	sydney: 'Australie'
};

export function createGetWeatherTool(context: PluginContext): AnyTool {
	const defaultCity = (context.pluginConfig.defaultCity as string) || context.env.WEATHER_DEFAULT_CITY || 'Paris';
	const units = (context.pluginConfig.units as string) || 'celsius';

	return tool({
		description: `Obtient les conditions meteorologiques actuelles pour une ville. Ville par defaut: ${defaultCity}. ATTENTION: Ce sont des donnees de demonstration, pas de vraies donnees meteo.`,
		inputSchema: jsonSchema<GetWeatherParams>({
			type: 'object',
			properties: {
				city: {
					type: 'string',
					description: `Nom de la ville (ex: Paris, London, Tokyo). Par defaut: ${defaultCity}`
				}
			},
			required: []
		}),
		execute: async (params): Promise<WeatherResult> => {
			const city = params.city || defaultCity;
			const cityLower = city.toLowerCase();

			context.logger.info('Getting weather', { city, units });

			// Get demo data
			const data = DEMO_WEATHER[cityLower] || DEMO_WEATHER.default;
			const country = COUNTRY_MAP[cityLower] || 'Inconnu';

			// Convert temperature if needed
			let temperature = data.tempCelsius;
			let unit = 'C';
			if (units === 'fahrenheit') {
				temperature = Math.round((data.tempCelsius * 9) / 5 + 32);
				unit = 'F';
			}

			const result: WeatherResult = {
				city: city.charAt(0).toUpperCase() + city.slice(1),
				country,
				temperature,
				unit,
				condition: data.condition,
				humidity: data.humidity,
				windSpeed: data.windSpeed,
				message: `Meteo a ${city}: ${data.condition}, ${temperature}°${unit}, humidite ${data.humidity}%, vent ${data.windSpeed} km/h. (Donnees de demonstration)`
			};

			return result;
		}
	});
}
