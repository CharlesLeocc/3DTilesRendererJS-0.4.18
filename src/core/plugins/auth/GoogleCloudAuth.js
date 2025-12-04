import { TraversalUtils } from '3d-tiles-renderer/core';

const TILES_MAP_URL = 'https://tile.googleapis.com/v1/createSession';

// Class for making fetches to Google Cloud, refreshing the token if needed.
// Supports both the 2d map tiles API in addition to 3d tiles.
export class GoogleCloudAuth {

	get isMapTilesSession() {

		return this.authURL === TILES_MAP_URL;

	}

	constructor( options = {} ) {

		const { apiToken, sessionOptions = null, autoRefreshToken = false, proxyURL = null } = options;
		this.apiToken = apiToken;
		this.autoRefreshToken = autoRefreshToken;
		this.authURL = TILES_MAP_URL;
		this.sessionToken = null;
		this.sessionOptions = sessionOptions;
		this._tokenRefreshPromise = null;
		this.proxyURL = proxyURL;

	}

	async fetch( url, options ) {

		// if we're using a map tiles session then we have to refresh the token separately
		if ( this.sessionToken === null && this.isMapTilesSession ) {

			this.refreshToken( options );

		}

		await this._tokenRefreshPromise;

		// construct the url
		const googleUrl = new URL( url );
		googleUrl.searchParams.set( 'key', this.apiToken );
		if ( this.sessionToken ) {

			googleUrl.searchParams.set( 'session', this.sessionToken );

		}

		let fetchUrl = googleUrl;
		if ( this.proxyURL ) {

			fetchUrl = new URL( this.proxyURL );
			fetchUrl.searchParams.set( 'url', googleUrl.toString() );

		}

		// try to refresh the session token if we failed to load it
		let res = await fetch( fetchUrl, options );
		if ( res.status >= 400 && res.status <= 499 && this.autoRefreshToken ) {

			// refresh the session token
			await this.refreshToken( options );
			if ( this.sessionToken ) {

				googleUrl.searchParams.set( 'session', this.sessionToken );

			}

			if ( this.proxyURL ) {

				fetchUrl = new URL( this.proxyURL );
				fetchUrl.searchParams.set( 'url', googleUrl.toString() );

			} else {

				fetchUrl = googleUrl;

			}

			res = await fetch( fetchUrl, options );

		}

		if ( this.sessionToken === null && ! this.isMapTilesSession ) {

			// if we're using a 3d tiles session then we get the session key in the first request
			return res
				.json()
				.then( json => {

					this.sessionToken = getSessionToken( json );
					return json;

				} );

		} else {

			return res;

		}

	}

	refreshToken( options ) {

		if ( this._tokenRefreshPromise === null ) {

			// construct the url to fetch the endpoint
			const authUrl = new URL( this.authURL );
			authUrl.searchParams.set( 'key', this.apiToken );

			// initialize options for map tiles
			const fetchOptions = { ...options };
			if ( this.isMapTilesSession ) {

				fetchOptions.method = 'POST';
				fetchOptions.body = JSON.stringify( this.sessionOptions );
				fetchOptions.headers = fetchOptions.headers || {};
				fetchOptions.headers = {
					...fetchOptions.headers,
					'Content-Type': 'application/json',
				};

			}

			let fetchUrl = authUrl;
			if ( this.proxyURL ) {

				fetchUrl = new URL( this.proxyURL );
				fetchUrl.searchParams.set( 'url', authUrl.toString() );

			}

			this._tokenRefreshPromise = fetch( fetchUrl, fetchOptions )
				.then( res => {

					if ( ! res.ok ) {

						throw new Error( `GoogleCloudAuth: Failed to load data with error code ${ res.status }` );

					}

					return res.json();

				} )
				.then( json => {

					this.sessionToken = getSessionToken( json );
					this._tokenRefreshPromise = null;

					return json;

				} );

		}

		return this._tokenRefreshPromise;

	}

}

// Takes a json response from the auth url and extracts the session token
function getSessionToken( json ) {

	if ( 'session' in json ) {

		// if using the 2d maps api
		return json.session;

	} else {

		// is using the 3d tiles api
		let sessionToken = null;
		const root = json.root;
		TraversalUtils.traverseSet( root, tile => {

			if ( tile.content && tile.content.uri ) {

				const [ , params ] = tile.content.uri.split( '?' );
				sessionToken = new URLSearchParams( params ).get( 'session' );
				return true;

			}

			return false;

		} );

		return sessionToken;

	}

}

