// Google Maps is loaded only after a configured address interaction.
// No coordinates are retained, returned to Dart, or requested on page load.
(() => {
  let loading;
  const sessions = new Map();
  const civicEndpoint = 'https://services2.arcgis.com/11XBiaBYA9Ep0yNJ/arcgis/rest/services/CivicAddresses/FeatureServer/0/query';
  const fail = (code) => Object.assign(new Error(code), { code });
  const messages = {
    'not-configured': 'Google 地址服务尚未配置，可先手动填写。',
    'permission-denied': '未获定位权限，请允许浏览器定位，或手动填写地址。',
    'position-unavailable': '暂时无法获取位置，请重试或手动填写。',
    'location-timeout': '获取位置超时，请重试或手动填写。',
    'no-results': '未找到对应地址，请搜索或手动填写。',
    'expired-selection': '地址建议已更新，请重新选择。',
    'request-failed': 'Google 地址服务暂不可用，请重试或手动填写。',
  };
  const response = async (action) => {
    try { return JSON.stringify(await action()); }
    catch (error) {
      const code = messages[error?.code] ? error.code : 'request-failed';
      return JSON.stringify({ error: code, message: messages[code] });
    }
  };

  const civicQuery = async (parameters) => {
    const query = new URLSearchParams({
      f: 'json', outFields: 'OBJECTID,FULL_CIVIC,STR_NAME,STR_TYPE,GSA_NAME',
      ...parameters,
    });
    const reply = await fetch(`${civicEndpoint}?${query}`, {
      credentials: 'omit',
      signal: AbortSignal.timeout(12000),
    });
    if (!reply.ok) throw fail('request-failed');
    const data = await reply.json();
    if (!Array.isArray(data.features)) throw fail('request-failed');
    return data.features;
  };

  const titleCase = (value) => (value || '').toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const civicAddress = ({ attributes }) => {
    const title = [attributes.FULL_CIVIC, titleCase(attributes.STR_NAME), attributes.STR_TYPE]
      .filter(Boolean).join(' ');
    const subtitle = [titleCase(attributes.GSA_NAME), 'NS'].filter(Boolean).join(', ');
    return { id: String(attributes.OBJECTID), title, subtitle, address: `${title}, ${subtitle}` };
  };

  const suggestCivic = async (query, sessionId) => {
    // Only these tokens can enter ArcGIS's query expression.
    const tokens = (query.toUpperCase().match(/[A-Z0-9]+/g) || [])
      .filter((token) => token !== 'NS' && token !== 'CANADA').slice(0, 6);
    if (!tokens.length) return { suggestions: [] };
    const where = tokens.map((token, index) => index === 0 && /^\d{1,6}$/.test(token)
      ? `CIV_NUM = ${Number(token)}`
      : `(STR_NAME LIKE '%${token}%' OR STR_TYPE LIKE '${token}%' OR GSA_NAME LIKE '${token}%')`
    ).join(' AND ');
    if (!sessions.has(sessionId)) sessions.set(sessionId, { predictions: new Map() });
    const { predictions } = sessions.get(sessionId);
    const features = await civicQuery({
      where, returnGeometry: 'false', resultRecordCount: '20',
      orderByFields: 'STR_NAME,CIV_NUM',
    });
    const suggestions = [];
    const seen = new Set();
    for (const feature of features) {
      const address = civicAddress(feature);
      if (seen.has(address.address)) continue;
      seen.add(address.address);
      predictions.set(address.id, address);
      suggestions.push({ id: address.id, title: address.title, subtitle: address.subtitle });
      if (suggestions.length === 5) break;
    }
    return { suggestions };
  };

  const locate = () => {
    if (!navigator.geolocation) throw fail('position-unavailable');
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, (error) => {
        reject(fail({1:'permission-denied',2:'position-unavailable',3:'location-timeout'}[error.code] || 'position-unavailable'));
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 });
    });
  };

  const currentCivic = async () => {
    const { coords: { latitude, longitude } } = await locate();
    const features = await civicQuery({
      where: '1=1', geometry: `${longitude},${latitude}`,
      geometryType: 'esriGeometryPoint', inSR: '4326', outSR: '4326',
      distance: '120', units: 'esriSRUnit_Meter',
      returnGeometry: 'true', resultRecordCount: '100',
    });
    const longitudeScale = Math.cos(latitude * Math.PI / 180);
    const distance = ({ geometry: { x, y } }) =>
      ((x - longitude) * longitudeScale) ** 2 + (y - latitude) ** 2;
    const [nearest] = features.filter((feature) => feature.geometry)
      .sort((a, b) => distance(a) - distance(b));
    if (!nearest) throw fail('no-results');
    return { address: civicAddress(nearest).address };
  };

  const load = async (key) => {
    if (!key) throw fail('not-configured');
    if (window.google?.maps?.importLibrary) return;
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => {
          script.remove();
          reject(fail('request-failed'));
        }, 15000);
        window.__hcaGoogleMapsReady = () => {
          clearTimeout(timer);
          resolve();
        };
        script.onerror = () => {
          clearTimeout(timer);
          script.remove();
          reject(fail('request-failed'));
        };
        const params = new URLSearchParams({
          key, v: 'quarterly', loading: 'async',
          language: 'en', region: 'CA', callback: '__hcaGoogleMapsReady',
        });
        script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
        script.async = true;
        document.head.append(script);
      }).catch((error) => { loading = undefined; throw error; });
    }
    await loading;
  };

  window.hcaPlaces = Object.freeze({
    suggest: (key, query, sessionId) => response(async () => {
      if (!key) return suggestCivic(query, sessionId);
      await load(key);
      const { AutocompleteSuggestion, AutocompleteSessionToken } =
        await google.maps.importLibrary('places');
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { token: new AutocompleteSessionToken(), predictions: new Map() });
      }
      const session = sessions.get(sessionId);
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: query,
        sessionToken: session.token,
        region: 'ca', language: 'en',
        // Public Halifax city-centre bias, not the user's current coordinates.
        locationBias: { center: { lat: 44.6488, lng: -63.5752 }, radius: 50000 },
      });
      const predictions = suggestions.map((s) => s.placePrediction).filter(Boolean).slice(0, 5);
      for (const prediction of predictions) session.predictions.set(prediction.placeId, prediction);
      return { suggestions: predictions.map((p) => ({
        id: p.placeId,
        title: p.mainText?.toString() || p.text.toString(),
        subtitle: p.secondaryText?.toString() || '',
      })) };
    }),
    select: (key, sessionId, id) => response(async () => {
      const prediction = sessions.get(sessionId)?.predictions.get(id);
      if (!prediction) throw fail('expired-selection');
      try {
        if (!key) return { address: prediction.address };
        await load(key);
        const place = prediction.toPlace();
        // Only request the field needed for this form; no photos or reviews.
        await place.fetchFields({ fields: ['formattedAddress'] });
        if (!place.formattedAddress) throw fail('no-results');
        return {
          address: place.formattedAddress,
          name: prediction.mainText?.toString() || '',
          placeId: id,
        };
      } finally { sessions.delete(sessionId); }
    }),
    current: (key) => response(async () => {
      if (!key) return currentCivic();
      await load(key);
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      // Called only by the explicitly labelled "使用我的位置" action.
      const position = await locate();
      const { results } = await new Geocoder().geocode({ location: {
        lat: position.coords.latitude, lng: position.coords.longitude,
      }});
      if (!results?.[0]?.formatted_address) throw fail('no-results');
      return { address: results[0].formatted_address, placeId: results[0].place_id || '' };
    }),
    reset: (sessionId) => sessions.delete(sessionId),
  });
})();
