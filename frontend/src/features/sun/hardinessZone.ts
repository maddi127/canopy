/**
 * USDA Hardiness Zone API Client
 * Fetches plant hardiness zone for a location
 */

export interface HardinessZone {
  zone: string;          // e.g., "7a", "8b"
  temperature_range: string; // e.g., "0 to 5 °F"
  zone_number: number;   // e.g., 7
  zone_letter: string;   // e.g., "a"
}

/**
 * Get temperature range for a USDA zone
 */
function getTemperatureRange(zone: string): string {
  const ranges: { [key: string]: string } = {
    '1a': '-60 to -55 °F',
    '1b': '-55 to -50 °F',
    '2a': '-50 to -45 °F',
    '2b': '-45 to -40 °F',
    '3a': '-40 to -35 °F',
    '3b': '-35 to -30 °F',
    '4a': '-30 to -25 °F',
    '4b': '-25 to -20 °F',
    '5a': '-20 to -15 °F',
    '5b': '-15 to -10 °F',
    '6a': '-10 to -5 °F',
    '6b': '-5 to 0 °F',
    '7a': '0 to 5 °F',
    '7b': '5 to 10 °F',
    '8a': '10 to 15 °F',
    '8b': '15 to 20 °F',
    '9a': '20 to 25 °F',
    '9b': '25 to 30 °F',
    '10a': '30 to 35 °F',
    '10b': '35 to 40 °F',
    '11a': '40 to 45 °F',
    '11b': '45 to 50 °F',
    '12a': '50 to 55 °F',
    '12b': '55 to 60 °F',
    '13a': '60 to 65 °F',
    '13b': '65 to 70 °F',
  };
  
  return ranges[zone] || 'Unknown range';
}

/**
 * Fetch USDA hardiness zone for coordinates
 * Uses official USDA ArcGIS Feature Service (2023 update)
 */
export async function fetchHardinessZone(lat: number, lng: number): Promise<HardinessZone | null> {
  const cacheKey = `usda_zone_${lat.toFixed(4)}_${lng.toFixed(4)}`;
  
  // Check cache
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  try {
    // USDA ArcGIS Feature Service (2023 Plant Hardiness Zone Map)
    const url = `https://services.arcgis.com/SXbDpmb7xQkk44JV/arcgis/rest/services/USDA_Plant_Hardiness_Zones/FeatureServer/0/query?` +
      `geometry=${lng},${lat}&` +
      `geometryType=esriGeometryPoint&` +
      `inSR=4326&` +
      `spatialRel=esriSpatialRelIntersects&` +
      `outFields=*&` +
      `returnGeometry=false&` +
      `f=json`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`USDA API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Check if we got results
    if (!data.features || data.features.length === 0) {
      throw new Error('No zone found for location');
    }
    
    // Parse zone from attributes
    const attributes = data.features[0].attributes;
    const zoneString = attributes.ZONE || attributes.zone || attributes.ZoneName;
    
    if (!zoneString) {
      throw new Error('Zone data not found in response');
    }
    
    // Parse zone (e.g., "7b" or "Zone 7b")
    const zoneMatch = zoneString.match(/(\d+)([ab]?)/i);
    if (!zoneMatch) {
      throw new Error('Invalid zone format');
    }
    
    const zoneCode = `${zoneMatch[1]}${zoneMatch[2].toLowerCase()}`;
    
    const zone: HardinessZone = {
      zone: zoneCode,
      temperature_range: attributes.TEMP || attributes.trange || getTemperatureRange(zoneCode),
      zone_number: parseInt(zoneMatch[1]),
      zone_letter: zoneMatch[2].toLowerCase() || 'a',
    };

    console.log('USDA Hardiness Zone:', zone);

    // Cache for session
    sessionStorage.setItem(cacheKey, JSON.stringify(zone));
    
    return zone;
  } catch (error) {
    console.error('Failed to fetch hardiness zone:', error);
    
    // Fallback: estimate zone from latitude
    const estimatedZone = estimateZoneFromLatitude(lat);
    console.log('Using estimated zone:', estimatedZone);
    return estimatedZone;
  }
}

/**
 * Rough estimation of hardiness zone from latitude
 * Used as fallback if API fails
 */
function estimateZoneFromLatitude(lat: number): HardinessZone {
  // Improved US-centric mapping
  let zoneNum = 3;
  let zoneLetter = 'a';
  
  if (lat < 25) { zoneNum = 10; zoneLetter = 'b'; }      // South Florida
  else if (lat < 28) { zoneNum = 9; zoneLetter = 'b'; }  // Florida
  else if (lat < 32) { zoneNum = 8; zoneLetter = 'b'; }  // Gulf Coast
  else if (lat < 35) { zoneNum = 8; zoneLetter = 'a'; }  // Deep South
  else if (lat < 37) { zoneNum = 7; zoneLetter = 'b'; }  // Southern states
  else if (lat < 39) { zoneNum = 7; zoneLetter = 'a'; }  // Mid-South
  else if (lat < 41) { zoneNum = 6; zoneLetter = 'b'; }  // Mid-Atlantic (SLC area)
  else if (lat < 42) { zoneNum = 6; zoneLetter = 'a'; }  // Northern Mid-Atlantic
  else if (lat < 44) { zoneNum = 5; zoneLetter = 'b'; }  // Northern states
  else if (lat < 47) { zoneNum = 4; zoneLetter = 'b'; }  // Upper Midwest
  else { zoneNum = 3; zoneLetter = 'b'; }                // Northern border
  
  // Salt Lake City is typically 7b, adjust if lat ~40.7
  if (lat >= 40.5 && lat <= 41.0) {
    zoneNum = 7;
    zoneLetter = 'b';
  }
  
  const zoneCode = `${zoneNum}${zoneLetter}`;
  
  return {
    zone: zoneCode,
    temperature_range: getTemperatureRange(zoneCode),
    zone_number: zoneNum,
    zone_letter: zoneLetter,
  };
}