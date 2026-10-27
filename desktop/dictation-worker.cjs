const { join } = require('node:path');
let recognizer, stream, session;
const port = process.parentPort;
port.on('message', event => {
  const message = event.data;
  try {
    let result;
    if (message.action === 'load') {
      const { OnlineRecognizer } = require(join(message.root, 'runtime/node_modules/sherpa-onnx-node'));
      recognizer = new OnlineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
        transducer: { encoder: join(message.root, 'models/encoder.int8.onnx'), decoder: join(message.root, 'models/decoder.onnx'), joiner: join(message.root, 'models/joiner.int8.onnx') },
        tokens: join(message.root, 'models/tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0, modelType: 'zipformer2',
      }, decodingMethod: 'greedy_search', enableEndpoint: false });
      result = true;
    } else if (message.action === 'begin') {
      if (!recognizer) throw Error('Speech model is not loaded');
      stream = recognizer.createStream(); session = message.session; result = true;
    } else {
      if (!stream || session !== message.session) throw Error('Speech session expired');
      if (message.action === 'write') {
        stream.acceptWaveform({ samples: message.samples, sampleRate: message.sampleRate });
        while (recognizer.isReady(stream)) recognizer.decode(stream);
        result = recognizer.getResult(stream).text;
      } else if (message.action === 'finish') {
        stream.acceptWaveform({ samples: new Float32Array(16000), sampleRate: 16000 });
        stream.inputFinished();
        while (recognizer.isReady(stream)) recognizer.decode(stream);
        result = recognizer.getResult(stream).text; stream = null; session = null;
      } else if (message.action === 'cancel') { stream = null; session = null; result = true; }
      else throw Error('Unknown speech operation');
    }
    port.postMessage({ id: message.id, ok: true, result });
  } catch (error) { port.postMessage({ id: message.id, ok: false, error: error.message }); }
});
