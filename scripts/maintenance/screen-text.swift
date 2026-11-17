import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
  guard let image = NSImage(contentsOfFile: path), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("\u{1}\(path)\tunreadable"); continue }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  request.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg).perform([request])
  print("\u{1}\(path)")
  for o in request.results ?? [] {
    guard let top = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    print(String(format: "%.4f %.4f %.4f %.4f\t", b.minX, 1 - b.maxY, b.width, b.height) + top.string)
  }
}
