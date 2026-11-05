/** Same signaling server as production, so `npm start` works without running anything else. */
export const environment = {
  production: false,
  peerjs: {
    host: 'zik2009-my-peerjs-server.hf.space',
    port: 443,
    path: '/myapp',
    secure: true
  }
};
