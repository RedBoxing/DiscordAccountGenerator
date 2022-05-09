import { path } from '@aw1875/ghost-cursor'

import * as tf from '@tensorflow/tfjs-node-gpu'
import * as path2 from 'path'

import fetch from 'node-fetch'

const weights = "file://" + path2.resolve('./best_web_model/model.json');

const names = ['airplane', 'bicycle', 'boat', 'bus', 'motorcycle', 'seaplane', 'train', 'truck']

let model : tf.GraphModel;

tf.loadGraphModel(weights).then(m => {
  model = m;
});

let i = 0;

export function randomString(length: number) : string {
    let result = "";
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

/**
* @description Randomize Function
* @param {*} start 
* @param {*} end 
* @returns Random int between start and end time
*/
export function rdn(start: number, end: number) : number {
    return Math.round(Math.random() * (end - start) + start);
}
  
/**
* @description Tensforflow Image Recognition Function
* @param {*} imgURL 
* @returns Predictions array
*/
export const tensor = async (imgURL: string) => {
  try {
    const blob = await fetch(imgURL).then((res) => res.buffer()).catch((err) => console.log(err));

    const [modelWidth, modelHeight] = model.inputs[0].shape.slice(1, 3);
    const input = tf.tidy(() => (tf.image.resizeBilinear(tf.node.decodeImage(blob as Buffer), [modelWidth, modelHeight]).div(255.0).expandDims(0)));
  
    // Classify the image.
    const res : tf.Tensor[] = await model.executeAsync(input) as tf.Tensor[];

    const [ boxes, scores, classes, valid_detections ] = res;
    const scores_data = scores.dataSync();
    const classes_data = classes.dataSync();
    const valid_detections_data = valid_detections.dataSync()[0];

    tf.dispose(res);
    
    const predictions = [];

    for (let i = 0; i < valid_detections_data; i++) {
      predictions.push({
        url: imgURL,
        class: names[classes_data[i]],
        score: scores_data[i],
      })
    }
  
    return predictions;
  } catch {
    return null;
  }
}
  
  /**
   * @description Generate mouse movements
   * @returns Mouse Movements array
   */
export const mm = () => {
    const from = { x: 100, y: 100 }
    const to = { x: 600, y: 700 }
  
    const route = path(from, to);
  
    const mm = [];
    route.forEach((i) => {
      mm.push([i.x, i.y, i.timestamp]);
    })
  
    return mm;
  }

export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}