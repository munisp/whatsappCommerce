use axum::{
    extract::Json,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;
use tracing::{info};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

impl BoundingBox {
    pub fn area(&self) -> f32 {
        let w = (self.x2 - self.x1).max(0.0);
        let h = (self.y2 - self.y1).max(0.0);
        w * h
    }

    pub fn iou(&self, other: &BoundingBox) -> f32 {
        let ix1 = self.x1.max(other.x1);
        let iy1 = self.y1.max(other.y1);
        let ix2 = self.x2.min(other.x2);
        let iy2 = self.y2.min(other.y2);
        let iw = (ix2 - ix1).max(0.0);
        let ih = (iy2 - iy1).max(0.0);
        let inter = iw * ih;
        if inter == 0.0 { return 0.0; }
        let union = self.area() + other.area() - inter;
        if union <= 0.0 { return 0.0; }
        inter / union
    }

    pub fn centre(&self) -> (f32, f32) {
        ((self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0)
    }

    pub fn edge_distance(&self, img_w: f32, img_h: f32) -> f32 {
        let (cx, cy) = self.centre();
        let dx = (cx / img_w - 0.5).abs();
        let dy = (cy / img_h - 0.5).abs();
        1.0 - 2.0 * dx.max(dy)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Detection {
    pub label: String,
    pub confidence: f32,
    pub bbox: BoundingBox,
    pub class_id: Option<i32>,
    #[serde(default)]
    pub adjusted_confidence: Option<f32>,
    #[serde(default)]
    pub cluster_id: Option<usize>,
    #[serde(default)]
    pub suppressed: bool,
}

#[derive(Debug, Deserialize)]
pub struct ProcessRequest {
    pub detections: Vec<Detection>,
    pub image_width: f32,
    pub image_height: f32,
    #[serde(default = "default_nms")]
    pub nms_threshold: f32,
    #[serde(default = "default_conf")]
    pub min_confidence: f32,
}

fn default_nms() -> f32 { 0.45 }
fn default_conf() -> f32 { 0.35 }

#[derive(Debug, Serialize)]
pub struct ProcessResponse {
    pub detections: Vec<Detection>,
    pub suppressed_count: usize,
    pub cluster_count: usize,
    pub processed: bool,
    pub processing_us: u64,
}

pub fn non_maximum_suppression(detections: &mut Vec<Detection>, iou_threshold: f32) -> usize {
    detections.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let n = detections.len();
    let mut suppressed = vec![false; n];
    let mut count = 0;
    for i in 0..n {
        if suppressed[i] { continue; }
        for j in (i + 1)..n {
            if suppressed[j] { continue; }
            if detections[i].label != detections[j].label { continue; }
            if detections[i].bbox.iou(&detections[j].bbox) > iou_threshold {
                suppressed[j] = true;
                count += 1;
            }
        }
    }
    for (i, d) in detections.iter_mut().enumerate() { d.suppressed = suppressed[i]; }
    count
}

pub fn rescore_by_edge_proximity(detections: &mut Vec<Detection>, img_w: f32, img_h: f32) {
    for d in detections.iter_mut() {
        if d.suppressed { continue; }
        let ed = d.bbox.edge_distance(img_w, img_h);
        let penalty = if ed < 0.1 { 0.15 } else if ed < 0.2 { 0.07 } else { 0.0 };
        d.adjusted_confidence = Some(((d.confidence - penalty).max(0.0) * 1000.0).round() / 1000.0);
    }
}

pub fn spatial_cluster(detections: &mut Vec<Detection>, img_w: f32, img_h: f32, ratio: f32) -> usize {
    let prox = ratio * img_w.min(img_h);
    let mut cluster_id = 0usize;
    let n = detections.len();
    let mut labels: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if detections[i].suppressed || labels[i].is_some() { continue; }
        labels[i] = Some(cluster_id);
        let (cx_i, cy_i) = detections[i].bbox.centre();
        for j in (i + 1)..n {
            if detections[j].suppressed || detections[j].label != detections[i].label { continue; }
            let (cx_j, cy_j) = detections[j].bbox.centre();
            let dist = ((cx_i - cx_j).powi(2) + (cy_i - cy_j).powi(2)).sqrt();
            if dist < prox { labels[j] = Some(cluster_id); }
        }
        cluster_id += 1;
    }
    for (i, d) in detections.iter_mut().enumerate() { d.cluster_id = labels[i]; }
    cluster_id
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({"status":"ok","service":"visual-inventory-bbox","version":"1.0.0"}))
}

async fn process_bboxes(Json(mut req): Json<ProcessRequest>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let start = std::time::Instant::now();
    if req.detections.is_empty() {
        return Ok(Json(ProcessResponse { detections: vec![], suppressed_count: 0, cluster_count: 0, processed: true, processing_us: 0 }));
    }
    info!("processing {} detections {}x{}", req.detections.len(), req.image_width, req.image_height);
    req.detections.retain(|d| d.confidence >= req.min_confidence);
    let suppressed_count = non_maximum_suppression(&mut req.detections, req.nms_threshold);
    rescore_by_edge_proximity(&mut req.detections, req.image_width, req.image_height);
    let cluster_count = spatial_cluster(&mut req.detections, req.image_width, req.image_height, 0.15);
    req.detections.retain(|d| !d.suppressed);
    let us = start.elapsed().as_micros() as u64;
    info!("done: {} dets, {} suppressed, {} clusters, {}us", req.detections.len(), suppressed_count, cluster_count, us);
    Ok(Json(ProcessResponse { detections: req.detections, suppressed_count, cluster_count, processed: true, processing_us: us }))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into())).json().init();
    let port: u16 = std::env::var("PORT").unwrap_or_else(|_| "8082".into()).parse().unwrap_or(8082);
    let app = Router::new()
        .route("/health", get(health))
        .route("/process", post(process_bboxes))
        .layer(CorsLayer::permissive());
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Rust bbox processor on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn b(x1:f32,y1:f32,x2:f32,y2:f32)->BoundingBox{BoundingBox{x1,y1,x2,y2}}
    fn d(label:&str,conf:f32,bbox:BoundingBox)->Detection{Detection{label:label.to_string(),confidence:conf,bbox,class_id:None,adjusted_confidence:None,cluster_id:None,suppressed:false}}
    #[test] fn iou_identical(){let bx=b(0.,0.,10.,10.);assert!((bx.iou(&bx)-1.0).abs()<1e-5);}
    #[test] fn iou_no_overlap(){let a=b(0.,0.,5.,5.);let bx=b(10.,10.,20.,20.);assert_eq!(a.iou(&bx),0.);}
    #[test] fn nms_removes_dup(){
        let mut dets=vec![d("bottle",0.9,b(0.,0.,10.,10.)),d("bottle",0.7,b(1.,1.,11.,11.))];
        let s=non_maximum_suppression(&mut dets,0.45);
        assert_eq!(s,1);assert!(!dets[0].suppressed);assert!(dets[1].suppressed);
    }
    #[test] fn nms_keeps_diff_class(){
        let mut dets=vec![d("bottle",0.9,b(0.,0.,10.,10.)),d("can",0.8,b(1.,1.,11.,11.))];
        assert_eq!(non_maximum_suppression(&mut dets,0.45),0);
    }
    #[test] fn edge_rescore(){
        let mut dets=vec![d("x",0.8,b(0.,0.,5.,5.)),d("x",0.8,b(47.5,47.5,52.5,52.5))];
        rescore_by_edge_proximity(&mut dets,100.,100.);
        assert!(dets[0].adjusted_confidence.unwrap()<dets[1].adjusted_confidence.unwrap());
    }
    #[test] fn cluster_groups_nearby(){
        let mut dets=vec![d("b",0.9,b(10.,10.,20.,20.)),d("b",0.85,b(25.,10.,35.,20.)),d("b",0.8,b(90.,90.,100.,100.))];
        let c=spatial_cluster(&mut dets,100.,100.,0.15);
        assert_eq!(c,2);assert_eq!(dets[0].cluster_id,dets[1].cluster_id);assert_ne!(dets[0].cluster_id,dets[2].cluster_id);
    }
}
