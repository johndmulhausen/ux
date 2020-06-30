import { UserSession, AppConfig } from 'blockstack';
import './types';
import { popupCenter } from './popup';

const defaultAuthURL = 'https://app.blockstack.org';

export interface FinishedData {
  authResponse: string;
  userSession: UserSession;
}

export interface AuthOptions {
  // The URL you want the user to be redirected to after authentication.
  redirectTo?: string;
  manifestPath?: string;
  finished?: (payload: FinishedData) => void;
  cancelled?: () => void;
  authOrigin?: string;
  sendToSignIn?: boolean;
  userSession?: UserSession;
  appDetails: {
    name: string;
    icon: string;
  };
}

export const authenticate = async ({
  redirectTo = '/',
  manifestPath,
  finished,
  cancelled,
  authOrigin,
  sendToSignIn = false,
  userSession,
  appDetails,
}: AuthOptions) => {
  if (!userSession) {
    const appConfig = new AppConfig(['store_write'], document.location.href);
    // eslint-disable-next-line no-param-reassign
    userSession = new UserSession({ appConfig });
  }
  if (userSession.isUserSignedIn()) {
    userSession.signUserOut();
  }
  const transitKey = userSession.generateAndStoreTransitKey();
  const authRequest = userSession.makeAuthRequest(
    transitKey,
    `${document.location.origin}${redirectTo}`,
    `${document.location.origin}${manifestPath}`,
    userSession.appConfig.scopes,
    undefined,
    undefined,
    {
      sendToSignIn,
      appDetails,
    }
  );

  const params = window.location.search
    .substr(1)
    .split('&')
    .filter(param => param.startsWith('utm'))
    .map(param => param.split('='));
  const urlParams = new URLSearchParams();
  params.forEach(([key, value]) => urlParams.set(key, value));
  urlParams.set('authRequest', authRequest);

  const path = sendToSignIn ? 'sign-in' : 'sign-up';

  const extensionURL = await window.BlockstackProvider?.getURL();
  const authURL = new URL(extensionURL || authOrigin || defaultAuthURL);

  const popup = popupCenter({
    url: `${authURL.origin}/index.html#/${path}?${urlParams.toString()}`,
    // If the extension is installed, dont worry about popup blocking
    // Otherwise, firefox will open the popup and a new tab.
    skipPopupFallback: !!window.BlockstackProvider,
  });

  setupListener({ popup, authRequest, finished, authURL, userSession, cancelled });
};

interface FinishedEventData {
  authResponse: string;
  authRequest: string;
  source: string;
}

interface ListenerParams {
  popup: Window | null;
  authRequest: string;
  finished?: (payload: FinishedData) => void;
  cancelled?: () => void;
  authURL: URL;
  userSession: UserSession;
}

const setupListener = ({
  popup,
  authRequest,
  finished,
  cancelled,
  authURL,
  userSession,
}: ListenerParams) => {
  let lastPong: number | null = null;

  const interval = setInterval(() => {
    if (popup) {
      try {
        popup.postMessage(
          {
            authRequest,
            method: 'ping',
          },
          authURL.origin
        );
      } catch (error) {
        console.warn('[Blockstack] Unable to send ping to authentication service');
        clearInterval(interval);
      }
    }
    if (lastPong && new Date().getTime() - lastPong > 200) {
      cancelled && cancelled();
      clearInterval(interval);
    }
  }, 100);

  const receiveMessage = async (event: MessageEvent) => {
    const authRequestMatch = event.data.authRequest === authRequest;
    if (!authRequestMatch) {
      return;
    }
    if (event.data.method === 'pong') {
      lastPong = new Date().getTime();
    } else {
      const data: FinishedEventData = event.data;
      if (finished) {
        window.focus();
        const { authResponse } = data;
        await userSession.handlePendingSignIn(authResponse);
        finished({
          authResponse,
          userSession,
        });
      }
      window.removeEventListener('message', receiveMessageCallback);
      clearInterval(interval);
    }
  };

  const receiveMessageCallback = (event: MessageEvent) => {
    receiveMessage(event);
  };

  window.addEventListener('message', receiveMessageCallback, false);
};
